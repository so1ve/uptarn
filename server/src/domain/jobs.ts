import { sha256Hex, timingSafeEqualText } from "../auth/index.ts";
import type { LoadedConfig } from "../config.ts";
import type { SqlDatabase, SqlStatement } from "../db/index.ts";
import { httpError } from "../http.ts";
import type { JobReportPayload } from "../shared/index.ts";
import { unixNow } from "../shared/index.ts";
import type { AlertStateRow } from "./alerts.ts";
import { ALERT_STATE_COLUMNS, buildAlertStatements } from "./alerts.ts";
import type { SettingRow } from "./settings.ts";
import { SELECT_SETTINGS_SQL, parseRuntimeSettings } from "./settings.ts";

export interface JobRow {
  key: string;
  node_id: string | null;
  label: string;
  interval_secs: number;
  grace_secs: number;
  muted_until: number;
  created_at: number;
  last_run_at: number;
  last_status: "ok" | "fail";
  last_duration_ms: number | null;
  last_summary: string | null;
  last_detail: string | null;
}

export async function ingestJobReport(
  db: SqlDatabase,
  config: LoadedConfig,
  payload: JobReportPayload,
  bearerToken: string,
): Promise<void> {
  const now = unixNow();
  const [tokenHash, isAdmin] = await Promise.all([
    sha256Hex(bearerToken),
    config.adminToken === null
      ? false
      : timingSafeEqualText(bearerToken, config.adminToken),
  ]);

  const incidentKey = `job:${payload.job_key}`;
  const readQueries: SqlStatement[] = [
    { sql: SELECT_SETTINGS_SQL },
    {
      sql: "SELECT label, grace_secs, muted_until, created_at FROM jobs WHERE key = ?1",
      params: [payload.job_key],
    },
    {
      sql: `SELECT ${ALERT_STATE_COLUMNS} FROM alert_states WHERE incident_key = ?1`,
      params: [incidentKey],
    },
  ];
  if (!isAdmin) {
    readQueries.push({
      sql: "SELECT id FROM nodes WHERE token_hash = ?1",
      params: [tokenHash],
    });
  }

  const [settingRows, jobRows, alertRows, nodeAuthRows] = (await db.allBatch(
    readQueries,
  )) as [
    SettingRow[],
    Pick<JobRow, "label" | "grace_secs" | "muted_until" | "created_at">[],
    AlertStateRow[],
    { id: string }[] | undefined,
  ];

  let resolvedNodeId = payload.node_id ?? null;
  if (!isAdmin) {
    const matched = nodeAuthRows?.[0];
    if (!matched || (resolvedNodeId && matched.id !== resolvedNodeId)) {
      throw httpError(401, "Invalid token for job report");
    }
    resolvedNodeId = matched.id;
  }

  const existing = jobRows[0] ?? null;
  const label = payload.label ?? existing?.label ?? payload.job_key;
  const graceSecs = payload.grace_secs ?? existing?.grace_secs ?? 3600;
  const mutedUntil = existing?.muted_until ?? 0;
  const settings = parseRuntimeSettings(settingRows, config);

  const alertStmts = await buildAlertStatements(
    config,
    [
      {
        incidentKey,
        targetType: "job",
        targetId: payload.job_key,
        label: `Job: ${label}`,
        failing: payload.status === "fail",
        summary:
          payload.summary ??
          (payload.status === "fail" ? "Job failed" : "Job succeeded"),
        threshold: 1,
        targetMutedUntil: mutedUntil,
      },
    ],
    alertRows,
    settings.globalMutedUntil,
    now,
  );

  await db.batch([
    {
      sql: `INSERT INTO jobs
            (key, node_id, label, interval_secs, grace_secs, muted_until, created_at, last_run_at, last_status, last_duration_ms, last_summary, last_detail)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
            ON CONFLICT(key) DO UPDATE SET
              node_id = COALESCE(excluded.node_id, jobs.node_id),
              label = excluded.label,
              interval_secs = excluded.interval_secs,
              grace_secs = excluded.grace_secs,
              last_run_at = excluded.last_run_at,
              last_status = excluded.last_status,
              last_duration_ms = excluded.last_duration_ms,
              last_summary = excluded.last_summary,
              last_detail = excluded.last_detail`,
      params: [
        payload.job_key,
        resolvedNodeId,
        label,
        payload.interval_secs,
        graceSecs,
        mutedUntil,
        existing?.created_at ?? now,
        now,
        payload.status,
        payload.duration_ms ?? null,
        payload.summary ?? null,
        payload.detail ?? null,
      ],
    },
    ...alertStmts,
  ]);
}
