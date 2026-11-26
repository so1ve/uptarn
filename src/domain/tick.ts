import type { LoadedConfig } from "../config.ts";
import type { SqlDatabase, SqlStatement } from "../db/index.ts";
import { formatAge, unixNow } from "../shared/index.ts";
import type { AlertObservation, AlertStateRow } from "./alerts.ts";
import { ALERT_STATE_COLUMNS, buildAlertStatements } from "./alerts.ts";
import type { JobRow } from "./jobs.ts";
import { jobNextDueAt, jobOverdueSummary } from "./jobs.ts";
import type { MaintenanceRow } from "./maintenances.ts";
import {
  SELECT_ACTIVE_MAINTENANCES_SQL,
  maintenanceMuteUntil,
  parseActiveMaintenances,
} from "./maintenances.ts";
import type { MonitorRow, ProbeResult } from "./monitors.ts";
import {
  buildMonitorResultStatement,
  monitorOkSummary,
  parseMonitorProbe,
  parseMonitorSamples,
  probeMonitor,
} from "./monitors.ts";
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

const MAX_SERIES_RETENTION_DAYS = 7;
const MAX_PROBES_PER_TICK = 25;

export async function runTick(
  db: SqlDatabase,
  config: LoadedConfig,
  options: TickOptions = {},
): Promise<TickReport> {
  const probeStart = unixNow();
  const candidates = await db.all<MonitorRow>(
    `SELECT id, probe_json, interval_secs, last_checked_at
     FROM monitors WHERE enabled = 1 AND probe_from = 'hub'`,
  );

  const dueMonitors = options.forceMonitors
    ? candidates
    : candidates
        .filter(
          (m) =>
            m.last_checked_at === null ||
            probeStart - m.last_checked_at >= Math.max(10, m.interval_secs - 5),
        )
        .sort((a, b) => (a.last_checked_at ?? 0) - (b.last_checked_at ?? 0))
        .slice(0, MAX_PROBES_PER_TICK);

  // Execute external HTTP probes before reading mutable state so slow I/O cannot cause stale overwrites.
  const probeResults = new Map<string, ProbeResult>();
  for (let i = 0; i < dueMonitors.length; i += 6) {
    const slice = dueMonitors.slice(i, i + 6);
    const results = await Promise.all(
      slice.map((m) => {
        const probe = parseMonitorProbe(m.probe_json);
        if (probe.from !== "hub") {
          throw new Error(`Expected hub probe for monitor ${m.id}`);
        }

        return probeMonitor(probe);
      }),
    );
    for (const [idx, res] of results.entries()) {
      probeResults.set(slice[idx].id, res);
    }
  }

  const now = unixNow();
  const [
    settingRows,
    allMonitors,
    nodes,
    jobs,
    existingAlertStates,
    activeMaintenanceRows,
  ] = (await db.allBatch([
    { sql: SELECT_SETTINGS_SQL },
    {
      sql: `SELECT id, name, probe_from, probe_json, managed_by_node_id, interval_secs,
                   enabled, muted_until, last_checked_at, last_status, samples_json, rollup_json
            FROM monitors`,
    },
    {
      sql: "SELECT id, label, interval_secs, grace_secs, muted_until, last_seen_at FROM nodes WHERE last_seen_at IS NOT NULL",
    },
    {
      sql: `SELECT key, label, managed_by_node_id, interval_secs, grace_secs, muted_until, created_at, last_run_at, next_run_at, last_status
            FROM jobs
            WHERE managed_by_node_id IS NULL
              AND interval_secs IS NOT NULL
              AND last_status NOT IN ('fail', 'overdue')`,
    },
    { sql: `SELECT ${ALERT_STATE_COLUMNS} FROM alert_states` },
    { sql: SELECT_ACTIVE_MAINTENANCES_SQL, params: [now] },
  ])) as [
    SettingRow[],
    MonitorRow[],
    TickNodeRow[],
    JobRow[],
    AlertStateRow[],
    MaintenanceRow[],
  ];

  const settings = parseRuntimeSettings(settingRows, config);
  const activeMaintenances = parseActiveMaintenances(activeMaintenanceRows);
  const observations: AlertObservation[] = [];
  const writeStatements: SqlStatement[] = [];
  let appliedProbes = 0;

  for (const m of allMonitors) {
    if (m.enabled !== 1) {
      continue;
    }
    const probe = parseMonitorProbe(m.probe_json);
    if (probe.from === "agent") {
      if (
        m.last_checked_at !== null &&
        now > m.last_checked_at + m.interval_secs + probe.grace_secs
      ) {
        const staleSummary = m.managed_by_node_id
          ? `No report from ${m.managed_by_node_id} since ${formatAge(m.last_checked_at, now)}`
          : `No report since ${formatAge(m.last_checked_at, now)}`;
        const lastSampleTs =
          parseMonitorSamples(m.samples_json).at(-1)?.ts ?? null;
        const needsSample =
          lastSampleTs === null ||
          now - lastSampleTs >= Math.max(30, m.interval_secs - 5);
        if (needsSample) {
          writeStatements.push(
            buildMonitorResultStatement(
              m,
              {
                ok: false,
                httpStatus: null,
                latencyMs: null,
                error: staleSummary,
              },
              now,
              { updateCheckedAt: false },
            ),
          );
        } else if (m.last_status !== "fail") {
          writeStatements.push({
            sql: "UPDATE monitors SET last_status = 'fail', last_http_status = NULL, last_latency_ms = NULL, last_error = ?1 WHERE id = ?2",
            params: [staleSummary, m.id],
          });
        }
        observations.push({
          incidentKey: `monitor:${m.id}`,
          targetType: "monitor",
          targetId: m.id,
          label: `Monitor: ${m.name}`,
          failing: true,
          summary: staleSummary,
          threshold: 1,
          targetMutedUntil: Math.max(
            m.muted_until,
            maintenanceMuteUntil(activeMaintenances, "monitor", m.id),
          ),
        });
      }

      continue;
    }
    const res = probeResults.get(m.id);
    if (!res) {
      continue;
    }
    appliedProbes += 1;
    writeStatements.push(buildMonitorResultStatement(m, res, now));
    observations.push({
      incidentKey: `monitor:${m.id}`,
      targetType: "monitor",
      targetId: m.id,
      label: `Monitor: ${m.name}`,
      failing: !res.ok,
      summary: res.ok
        ? monitorOkSummary(probe.type, res)
        : (res.error ?? "Request failed"),
      threshold: config.failureThreshold,
      targetMutedUntil: Math.max(
        m.muted_until,
        maintenanceMuteUntil(activeMaintenances, "monitor", m.id),
      ),
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
        targetMutedUntil: Math.max(
          node.muted_until,
          maintenanceMuteUntil(activeMaintenances, "node", node.id),
        ),
      });
    }
  }

  for (const job of jobs) {
    const dueAt = jobNextDueAt(job);
    if (dueAt !== null && now > dueAt + job.grace_secs) {
      observations.push({
        incidentKey: `job:${job.key}`,
        targetType: "job",
        targetId: job.key,
        label: `Job: ${job.label}`,
        failing: true,
        summary: jobOverdueSummary(job, now),
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
    const seriesCutoff =
      now - Math.min(config.retentionDays, MAX_SERIES_RETENTION_DAYS) * 86_400;
    for (const node of nodes) {
      writeStatements.push({
        sql: "DELETE FROM node_samples WHERE node_id = ?1 AND ts < ?2",
        params: [node.id, seriesCutoff],
      });
    }
    writeStatements.push(
      {
        sql: "DELETE FROM alert_events WHERE created_at < ?1",
        params: [now - config.retentionDays * 86_400],
      },
      {
        sql: "DELETE FROM maintenances WHERE ends_at < ?1",
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
