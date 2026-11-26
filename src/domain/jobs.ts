import { generateRandomToken, sha256Hex } from "../auth/index.ts";
import type { LoadedConfig } from "../config.ts";
import type { SqlDatabase, SqlStatement } from "../db/index.ts";
import { httpError } from "../http.ts";
import type {
  JobInput,
  JobOverallStatus,
  JobRunStatus,
} from "../shared/index.ts";
import { formatAge, formatDuration, unixNow } from "../shared/index.ts";
import { parseJobInput } from "../validation.ts";
import type { AlertStateRow } from "./alerts.ts";
import { ALERT_STATE_COLUMNS, buildAlertStatements } from "./alerts.ts";
import type { SettingRow } from "./settings.ts";
import { SELECT_SETTINGS_SQL, parseRuntimeSettings } from "./settings.ts";

export interface JobRow {
  key: string;
  node_id: string | null;
  managed_by_node_id: string | null;
  ping_token_hash: string | null;
  label: string;
  schedule: string | null;
  interval_secs: number | null;
  grace_secs: number;
  muted_until: number;
  created_at: number;
  started_at: number | null;
  last_run_at: number | null;
  next_run_at: number | null;
  last_status: JobRunStatus;
  last_duration_ms: number | null;
  last_summary: string | null;
  last_detail: string | null;
}

export type JobPingAction = "ok" | "start" | "fail";

export interface JobDueFields {
  managed_by_node_id: string | null;
  created_at: number;
  last_run_at: number | null;
  next_run_at: number | null;
  interval_secs: number | null;
}

export function jobNextDueAt(job: JobDueFields): number | null {
  if (job.managed_by_node_id !== null) {
    return job.next_run_at;
  }
  if (job.interval_secs === null) {
    return null;
  }

  return (job.last_run_at ?? job.created_at) + job.interval_secs;
}

export function jobOverallStatus(
  job: JobDueFields & { grace_secs: number; last_status: JobRunStatus },
  now: number,
): JobOverallStatus {
  if (job.managed_by_node_id !== null) {
    return job.last_status;
  }
  if (job.last_status === "fail" || job.last_status === "overdue") {
    return job.last_status;
  }
  const dueAt = jobNextDueAt(job);
  if (dueAt !== null && now > dueAt + job.grace_secs) {
    return "overdue";
  }

  return job.last_status;
}

export function jobOverdueSummary(
  job: { last_run_at: number | null; interval_secs: number | null },
  now: number,
): string {
  if (job.last_run_at === null) {
    return job.interval_secs === null
      ? "Overdue: never reported"
      : `Overdue: never reported (expected every ${formatDuration(job.interval_secs)})`;
  }

  return `Overdue: last finished ${formatAge(job.last_run_at, now)}`;
}

async function issueJobPingToken() {
  const token = generateRandomToken("uptn_job");

  return { token, hash: await sha256Hex(token) };
}

export const buildJobPingUrl = (publicBaseUrl: string, token: string): string =>
  `${publicBaseUrl.replace(/\/+$/, "")}/ping/${token}`;

export async function assertJobHubManaged(
  db: SqlDatabase,
  key: string,
): Promise<void> {
  const existing = await db.first<{ managed_by_node_id: string | null }>(
    "SELECT managed_by_node_id FROM jobs WHERE key = ?1",
    [key],
  );
  if (existing?.managed_by_node_id) {
    throw httpError(
      409,
      `Job "${key}" is managed by node "${existing.managed_by_node_id}"`,
    );
  }
}

export async function createPushJob(
  db: SqlDatabase,
  config: LoadedConfig,
  raw: JobInput | unknown,
): Promise<{ key: string; label: string; token: string; ping_url: string }> {
  const input = parseJobInput(raw);
  const { token, hash } = await issueJobPingToken();
  const res = await db.run(
    `INSERT OR IGNORE INTO jobs
       (key, node_id, managed_by_node_id, ping_token_hash, label, schedule, interval_secs, grace_secs, created_at, last_status)
     VALUES (?1, NULL, NULL, ?2, ?3, ?4, ?5, ?6, ?7, 'pending')`,
    [
      input.key,
      hash,
      input.label,
      input.schedule,
      input.interval_secs,
      input.grace_secs,
      unixNow(),
    ],
  );
  if (res.changes === 0) {
    throw httpError(409, `Job "${input.key}" already exists`);
  }

  return {
    key: input.key,
    label: input.label,
    token,
    ping_url: buildJobPingUrl(config.publicBaseUrl, token),
  };
}

export async function updatePushJob(
  db: SqlDatabase,
  key: string,
  patch: {
    label?: string;
    schedule?: string | null;
    interval_secs?: number | null;
    grace_secs?: number;
  },
): Promise<boolean> {
  const existing = await db.first<{ managed_by_node_id: string | null }>(
    "SELECT managed_by_node_id FROM jobs WHERE key = ?1",
    [key],
  );
  if (!existing) {
    return false;
  }
  if (existing.managed_by_node_id) {
    throw httpError(
      409,
      `Job "${key}" is managed by node "${existing.managed_by_node_id}"`,
    );
  }
  const sets: string[] = [];
  const params: (string | number | null)[] = [];
  if (patch.label !== undefined) {
    params.push(patch.label);
    sets.push(`label = ?${params.length}`);
  }
  if (patch.schedule !== undefined) {
    params.push(patch.schedule);
    sets.push(`schedule = ?${params.length}`);
  }
  if (patch.interval_secs !== undefined) {
    params.push(patch.interval_secs);
    sets.push(`interval_secs = ?${params.length}`);
  }
  if (patch.grace_secs !== undefined) {
    params.push(patch.grace_secs);
    sets.push(`grace_secs = ?${params.length}`);
  }
  params.push(key);
  const res = await db.run(
    `UPDATE jobs SET ${sets.join(", ")} WHERE key = ?${params.length}`,
    params,
  );

  return res.changes > 0;
}

export async function rotateJobPingToken(
  db: SqlDatabase,
  config: LoadedConfig,
  key: string,
): Promise<{ key: string; token: string; ping_url: string }> {
  const existing = await db.first<{ managed_by_node_id: string | null }>(
    "SELECT managed_by_node_id FROM jobs WHERE key = ?1",
    [key],
  );
  if (!existing) {
    throw httpError(404, `Job "${key}" not found`);
  }
  if (existing.managed_by_node_id) {
    throw httpError(
      409,
      `Job "${key}" is managed by node "${existing.managed_by_node_id}"`,
    );
  }
  const { token, hash } = await issueJobPingToken();
  await db.run("UPDATE jobs SET ping_token_hash = ?1 WHERE key = ?2", [
    hash,
    key,
  ]);

  return {
    key,
    token,
    ping_url: buildJobPingUrl(config.publicBaseUrl, token),
  };
}

function summarizePingBody(
  body: string | null,
  pick: "first" | "last",
): string | null {
  if (!body) {
    return null;
  }
  const lines = body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const chosen = pick === "first" ? lines[0] : lines.at(-1);

  return chosen ? chosen.slice(0, 240) : null;
}

export async function handleJobPing(
  db: SqlDatabase,
  config: LoadedConfig,
  token: string,
  action: JobPingAction,
  options: { body?: string | null; durationMs?: number | null } = {},
): Promise<void> {
  const now = unixNow();
  const tokenHash = await sha256Hex(token);
  const job = await db.first<JobRow>(
    "SELECT * FROM jobs WHERE ping_token_hash = ?1",
    [tokenHash],
  );
  if (!job) {
    throw httpError(404, "Not found");
  }

  const body = options.body?.trim() ? options.body.trim().slice(0, 4096) : null;

  if (action === "start") {
    await db.run(
      `UPDATE jobs
       SET started_at = ?1,
           last_status = 'running',
           last_summary = COALESCE(?2, last_summary),
           last_detail = NULL
       WHERE key = ?3`,
      [now, summarizePingBody(body, "first"), job.key],
    );

    return;
  }

  const durationMs =
    options.durationMs !== undefined && options.durationMs !== null
      ? Math.max(0, Math.floor(options.durationMs))
      : job.started_at !== null && now >= job.started_at
        ? (now - job.started_at) * 1000
        : null;

  const isFail = action === "fail";
  const summary = isFail
    ? (summarizePingBody(body, "last") ?? "Job failed")
    : (summarizePingBody(body, "first") ??
      (durationMs === null
        ? "ok"
        : `completed in ${(durationMs / 1000).toFixed(1)}s`));
  const detail = isFail ? body : null;

  const incidentKey = `job:${job.key}`;
  const [settingRows, alertRows] = (await db.allBatch([
    { sql: SELECT_SETTINGS_SQL },
    {
      sql: `SELECT ${ALERT_STATE_COLUMNS} FROM alert_states WHERE incident_key = ?1`,
      params: [incidentKey],
    },
  ])) as [SettingRow[], AlertStateRow[]];
  const settings = parseRuntimeSettings(settingRows, config);

  const alertStmts = await buildAlertStatements(
    config.publicBaseUrl,
    settings.notifications,
    [
      {
        incidentKey,
        targetType: "job",
        targetId: job.key,
        label: `Job: ${job.label}`,
        failing: isFail,
        summary,
        threshold: 1,
        targetMutedUntil: job.muted_until,
      },
    ],
    alertRows,
    settings.globalMutedUntil,
    now,
  );

  const statements: SqlStatement[] = [
    {
      sql: `UPDATE jobs
            SET started_at = NULL,
                last_run_at = ?1,
                next_run_at = NULL,
                last_status = ?2,
                last_duration_ms = ?3,
                last_summary = ?4,
                last_detail = ?5
            WHERE key = ?6`,
      params: [
        now,
        isFail ? "fail" : "ok",
        durationMs,
        summary,
        detail,
        job.key,
      ],
    },
    ...alertStmts,
  ];
  await db.batch(statements);
}
