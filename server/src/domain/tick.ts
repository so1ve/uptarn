import type { LoadedConfig } from "../config.ts";
import type { SqlDatabase, SqlStatement } from "../db/index.ts";
import { formatAge, unixNow } from "../shared/index.ts";
import type { AlertObservation, AlertStateRow } from "./alerts.ts";
import { ALERT_STATE_COLUMNS, buildAlertStatements } from "./alerts.ts";
import type { JobRow } from "./jobs.ts";
import type { MonitorRow, ProbeResult } from "./monitors.ts";
import { probeMonitor } from "./monitors.ts";
import type { SettingRow } from "./settings.ts";
import {
  SELECT_SETTINGS_SQL,
  parseRuntimeSettings,
  upsertSettingStmt,
} from "./settings.ts";

interface TickNodeRow {
  id: string;
  label: string;
  interval_secs: number;
  grace_secs: number;
  muted_until: number;
  last_seen_at: number;
}

export interface TickOptions {
  forceMonitors?: boolean;
}

export interface TickReport {
  probed_monitors: number;
  evaluated_nodes: number;
  evaluated_jobs: number;
  pruned: boolean;
}

const SERIES_RETENTION_SECS = 7 * 3600;

export async function runTick(
  db: SqlDatabase,
  config: LoadedConfig,
  options: TickOptions = {},
): Promise<TickReport> {
  const probeStart = unixNow();
  const candidates = await db.all<
    Pick<
      MonitorRow,
      | "id"
      | "url"
      | "method"
      | "expected_status_min"
      | "expected_status_max"
      | "expected_body"
      | "timeout_ms"
      | "interval_secs"
      | "last_checked_at"
    >
  >(
    `SELECT id, url, method, expected_status_min, expected_status_max,
            expected_body, timeout_ms, interval_secs, last_checked_at
     FROM monitors WHERE enabled = 1`,
  );

  const dueMonitors = options.forceMonitors
    ? candidates
    : candidates.filter(
        (m) =>
          m.last_checked_at === null ||
          probeStart - m.last_checked_at >= Math.max(10, m.interval_secs - 5),
      );

  // Execute external HTTP probes before reading mutable alert/node/job state
  // so slow network I/O never causes stale state overwrites.
  const probeResults = new Map<string, ProbeResult>();
  for (let i = 0; i < dueMonitors.length; i += 6) {
    const slice = dueMonitors.slice(i, i + 6);
    const results = await Promise.all(slice.map((m) => probeMonitor(m)));
    for (const [idx, res] of results.entries()) {
      probeResults.set(slice[idx].id, res);
    }
  }

  const now = unixNow();
  const [settingRows, allMonitors, nodes, jobs, existingAlertStates] =
    (await db.allBatch([
      { sql: SELECT_SETTINGS_SQL },
      {
        sql: "SELECT id, name, enabled, muted_until FROM monitors",
      },
      {
        sql: `SELECT id, label, interval_secs, grace_secs, muted_until, last_seen_at
              FROM nodes WHERE last_seen_at IS NOT NULL`,
      },
      {
        sql: `SELECT key, label, interval_secs, grace_secs, muted_until, last_run_at
              FROM jobs WHERE last_status = 'ok'`,
      },
      { sql: `SELECT ${ALERT_STATE_COLUMNS} FROM alert_states` },
    ])) as [
      SettingRow[],
      Pick<MonitorRow, "id" | "name" | "enabled" | "muted_until">[],
      TickNodeRow[],
      Pick<
        JobRow,
        | "key"
        | "label"
        | "interval_secs"
        | "grace_secs"
        | "muted_until"
        | "last_run_at"
      >[],
      AlertStateRow[],
    ];

  const settings = parseRuntimeSettings(settingRows, config);
  const observations: AlertObservation[] = [];
  const writeStatements: SqlStatement[] = [];

  const sampleBucketTs = Math.floor(now / 30) * 30;
  let appliedProbes = 0;
  for (const m of allMonitors) {
    if (m.enabled !== 1) {
      continue;
    }
    const res = probeResults.get(m.id);
    if (!res) {
      continue;
    }
    appliedProbes += 1;
    writeStatements.push(
      {
        sql: `UPDATE monitors SET
                last_checked_at = ?1, last_status = ?2, last_http_status = ?3,
                last_latency_ms = ?4, last_error = ?5
              WHERE id = ?6`,
        params: [
          now,
          res.ok ? "ok" : "fail",
          res.httpStatus,
          res.latencyMs,
          res.error,
          m.id,
        ],
      },
      {
        sql: `INSERT OR REPLACE INTO monitor_samples (monitor_id, ts, ok, latency_ms, http_status)
              VALUES (?1, ?2, ?3, ?4, ?5)`,
        params: [
          m.id,
          sampleBucketTs,
          res.ok ? 1 : 0,
          res.latencyMs,
          res.httpStatus,
        ],
      },
    );

    observations.push({
      incidentKey: `monitor:${m.id}`,
      targetType: "monitor",
      targetId: m.id,
      label: `HTTP: ${m.name}`,
      failing: !res.ok,
      summary: res.ok
        ? `HTTP ${res.httpStatus ?? 200} in ${res.latencyMs ?? 0} ms`
        : (res.error ?? "Request failed"),
      threshold: config.failureThreshold,
      targetMutedUntil: m.muted_until,
    });
  }

  for (const node of nodes) {
    if (now > node.last_seen_at + node.interval_secs + node.grace_secs) {
      observations.push({
        incidentKey: `node:${node.id}:offline`,
        targetType: "node",
        targetId: node.id,
        label: `${node.label}: Connectivity`,
        failing: true,
        summary: `No report since ${formatAge(node.last_seen_at, now)} (expected every ${node.interval_secs}s)`,
        threshold: 1,
        targetMutedUntil: node.muted_until,
      });
    }
  }

  for (const job of jobs) {
    if (now > job.last_run_at + job.interval_secs + job.grace_secs) {
      observations.push({
        incidentKey: `job:${job.key}`,
        targetType: "job",
        targetId: job.key,
        label: `Job: ${job.label}`,
        failing: true,
        summary: `Overdue: last finished ${formatAge(job.last_run_at, now)}`,
        threshold: 1,
        targetMutedUntil: job.muted_until,
      });
    }
  }

  writeStatements.push(
    ...(await buildAlertStatements(
      config,
      observations,
      existingAlertStates,
      settings.globalMutedUntil,
      now,
    )),
  );

  let pruned = false;
  if (now - settings.lastPruneAt >= 3600) {
    writeStatements.push({
      sql: "DELETE FROM series_samples WHERE ts < ?1",
      params: [now - SERIES_RETENTION_SECS],
    });
    for (const m of allMonitors) {
      writeStatements.push({
        sql: `DELETE FROM monitor_samples
              WHERE monitor_id = ?1
                AND ts < COALESCE(
                  (SELECT s2.ts FROM monitor_samples s2
                   WHERE s2.monitor_id = ?1
                   ORDER BY s2.monitor_id DESC, s2.ts DESC LIMIT 1 OFFSET 48),
                  0
                )`,
        params: [m.id],
      });
    }
    writeStatements.push(
      {
        sql: "DELETE FROM alert_events WHERE created_at < ?1",
        params: [now - config.retentionDays * 86_400],
      },
      {
        sql: "DELETE FROM admin_sessions WHERE expires_at <= ?1",
        params: [now],
      },
      {
        sql: "DELETE FROM webauthn_challenges WHERE expires_at <= ?1",
        params: [now],
      },
      upsertSettingStmt("last_prune_at", String(now), now),
    );
    pruned = true;
  }

  await db.batch(writeStatements);

  return {
    probed_monitors: appliedProbes,
    evaluated_nodes: nodes.length,
    evaluated_jobs: jobs.length,
    pruned,
  };
}
