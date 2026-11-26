import {
  generateRandomToken,
  sha256Hex,
  timingSafeEqualText,
} from "../auth/index.ts";
import type { LoadedConfig } from "../config.ts";
import type { SqlDatabase, SqlParam, SqlStatement } from "../db/index.ts";
import { httpError } from "../http.ts";
import type {
  JobRunStatus,
  MonitorProbe,
  NodeJobSnapshot,
  NodeMonitorSpec,
  NodeReportPayload,
  SeriesPoint,
} from "../shared/index.ts";
import {
  formatSeriesWithLoss,
  formatUsage,
  memPercent,
  percent,
  round1,
  unixNow,
} from "../shared/index.ts";
import type { AlertObservation, AlertStateRow } from "./alerts.ts";
import { ALERT_STATE_COLUMNS, buildAlertStatements } from "./alerts.ts";
import type { MaintenanceRow } from "./maintenances.ts";
import {
  SELECT_ACTIVE_MAINTENANCES_SQL,
  maintenanceMuteUntil,
  parseActiveMaintenances,
} from "./maintenances.ts";
import type { MonitorConfigFields, ProbeResult } from "./monitors.ts";
import {
  MONITOR_CONFIG_KEYS,
  buildMonitorResultStatement,
  buildMonitorUpsertStatements,
  monitorOkSummary,
} from "./monitors.ts";
import type { SettingRow } from "./settings.ts";
import { SELECT_SETTINGS_SQL, parseRuntimeSettings } from "./settings.ts";

const SPARK_STEP_SECS = 450;
const MAX_SPARK_BUCKETS = 48;

type CompactSparkEntry =
  [sum: number, count: number] | [sum: number, count: number, maxAux: number];
type CompactSparkBucket = [
  ts: number,
  values: Record<string, CompactSparkEntry>,
];

export function appendNodeSpark(
  raw: string | null | undefined,
  sampleValues: Record<string, number | [number, number]>,
  now: number,
): string {
  const bucketTs = Math.floor(now / SPARK_STEP_SECS) * SPARK_STEP_SECS;
  const minTs = bucketTs - (MAX_SPARK_BUCKETS - 1) * SPARK_STEP_SECS;
  const buckets = (raw ? (JSON.parse(raw) as CompactSparkBucket[]) : []).filter(
    (b) => b[0] >= minTs,
  );
  const entries = Object.entries(sampleValues);
  if (entries.length === 0) {
    return JSON.stringify(buckets);
  }

  let bucket = buckets.find((b) => b[0] === bucketTs);
  if (!bucket) {
    bucket = [bucketTs, {}];
    buckets.push(bucket);
  }
  const values = bucket[1];
  for (const [key, entry] of entries) {
    const val = Array.isArray(entry) ? entry[0] : entry;
    const aux = Array.isArray(entry) ? entry[1] : undefined;
    const prev = values[key];
    if (prev) {
      const nextSum = round1(prev[0] + val);
      const nextCount = prev[1] + 1;
      const prevAux = prev[2];
      const nextAux =
        aux === undefined
          ? prevAux
          : prevAux === undefined
            ? aux
            : Math.max(prevAux, aux);
      values[key] =
        nextAux === undefined
          ? [nextSum, nextCount]
          : [nextSum, nextCount, nextAux];
    } else {
      values[key] = aux === undefined ? [val, 1] : [val, 1, aux];
    }
  }
  buckets.sort((a, b) => a[0] - b[0]);

  return JSON.stringify(buckets.slice(-MAX_SPARK_BUCKETS));
}

export function parseNodeSpark(
  raw: string | null | undefined,
  allowedKeys: ReadonlySet<string>,
  now: number,
): Record<string, SeriesPoint[]> {
  if (!raw || allowedKeys.size === 0) {
    return {};
  }
  const minTs =
    Math.floor(now / SPARK_STEP_SECS) * SPARK_STEP_SECS -
    (MAX_SPARK_BUCKETS - 1) * SPARK_STEP_SECS;
  const buckets = JSON.parse(raw) as CompactSparkBucket[];
  const hist: Record<string, SeriesPoint[]> = {};
  for (const [ts, values] of buckets) {
    if (ts < minTs) {
      continue;
    }
    for (const [key, entry] of Object.entries(values)) {
      if (allowedKeys.has(key)) {
        (hist[key] ??= []).push({
          ts,
          value: round1(entry[0] / entry[1]),
          aux: entry[2] ?? null,
        });
      }
    }
  }
  for (const pts of Object.values(hist)) {
    pts.sort((a, b) => a.ts - b.ts);
  }

  return hist;
}

interface NodeIngestRow {
  id: string;
  label: string;
  token_hash: string;
  interval_secs: number;
  grace_secs: number;
  muted_until: number;
  is_public: number;
  prev_rx_bytes: number | null;
  prev_tx_bytes: number | null;
  prev_net_at: number | null;
  rx_bps: number | null;
  tx_bps: number | null;
  month_rx_bytes: number;
  month_tx_bytes: number;
  traffic_reset_day: number;
  traffic_period_start: number;
  spark_json: string;
}

async function issueNodeToken() {
  const token = generateRandomToken("uptn_node");

  return { token, hash: await sha256Hex(token) };
}

export async function createNode(
  db: SqlDatabase,
  input: {
    id: string;
    label?: string;
    group?: string | null;
    interval_secs?: number;
    grace_secs?: number;
    is_public?: boolean;
  },
): Promise<{ id: string; label: string; token: string }> {
  const { token, hash } = await issueNodeToken();
  const label = input.label?.trim() || input.id;
  const res = await db.run(
    `INSERT OR IGNORE INTO nodes (id, label, group_name, token_hash, interval_secs, grace_secs, is_public, sort_order, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, COALESCE((SELECT MAX(sort_order) + 1 FROM nodes), 0), ?8)`,
    [
      input.id,
      label,
      input.group ?? null,
      hash,
      input.interval_secs ?? 60,
      input.grace_secs ?? 120,
      input.is_public ? 1 : 0,
      unixNow(),
    ],
  );
  if (res.changes === 0) {
    throw httpError(409, `Node "${input.id}" already exists`);
  }

  return { id: input.id, label, token };
}

export async function updateNode(
  db: SqlDatabase,
  nodeId: string,
  patch: {
    is_public?: boolean;
    primary_mount?: string | null;
    group?: string | null;
    traffic_reset_day?: number;
  },
): Promise<boolean> {
  const existing = await db.first<{ public_managed: number }>(
    "SELECT public_managed FROM nodes WHERE id = ?1",
    [nodeId],
  );
  if (!existing) {
    return false;
  }
  if (patch.is_public !== undefined && existing.public_managed === 1) {
    throw httpError(409, `Node "${nodeId}" visibility is managed by its agent`);
  }
  const sets: string[] = [];
  const params: (string | number | null)[] = [];
  if (patch.is_public !== undefined) {
    params.push(patch.is_public ? 1 : 0);
    sets.push(`is_public = ?${params.length}`);
  }
  if (patch.primary_mount !== undefined) {
    params.push(patch.primary_mount);
    sets.push(`primary_mount = ?${params.length}`);
  }
  if (patch.group !== undefined) {
    params.push(patch.group);
    sets.push(`group_name = ?${params.length}`);
  }
  if (patch.traffic_reset_day !== undefined) {
    params.push(patch.traffic_reset_day);
    sets.push(`traffic_reset_day = ?${params.length}`);
    params.push(trafficPeriodStart(unixNow(), patch.traffic_reset_day));
    sets.push(`traffic_period_start = ?${params.length}`);
  }
  params.push(nodeId);
  const res = await db.run(
    `UPDATE nodes SET ${sets.join(", ")} WHERE id = ?${params.length}`,
    params,
  );

  return res.changes > 0;
}

export async function rotateNodeToken(
  db: SqlDatabase,
  nodeId: string,
): Promise<{ id: string; token: string }> {
  const { token, hash } = await issueNodeToken();
  const res = await db.run("UPDATE nodes SET token_hash = ?1 WHERE id = ?2", [
    hash,
    nodeId,
  ]);
  if (res.changes === 0) {
    throw httpError(404, `Node "${nodeId}" not found`);
  }

  return { id: nodeId, token };
}

interface ManagedMonitorRow extends MonitorConfigFields {
  muted_until: number;
  samples_json: string;
  rollup_json: string;
}

function buildManagedMonitorStatements(
  nodeId: string,
  nodeIntervalSecs: number,
  nodeGraceSecs: number,
  failureThreshold: number,
  specs: readonly NodeMonitorSpec[],
  existing: readonly ManagedMonitorRow[],
  activeMaintenances: ReturnType<typeof parseActiveMaintenances>,
  now: number,
): { statements: SqlStatement[]; observations: AlertObservation[] } {
  const statements: SqlStatement[] = [];
  const observations: AlertObservation[] = [];
  const existingById = new Map(existing.map((row) => [row.id, row]));
  const nextIds = new Set<string>();

  for (const spec of specs) {
    const id = `${nodeId}:${spec.key}`.slice(0, 64);
    const probe: MonitorProbe =
      spec.from === "agent"
        ? {
            from: "agent",
            type: spec.type,
            target: spec.target ?? null,
            grace_secs: spec.grace_secs ?? nodeGraceSecs,
          }
        : {
            from: "hub",
            type: "http",
            url: spec.url,
            method: spec.method ?? "GET",
            expected_status_min: spec.expected_status_min ?? 200,
            expected_status_max:
              spec.expected_status_max ??
              Math.max(299, spec.expected_status_min ?? 200),
            expected_body: spec.expected_body ?? null,
            timeout_ms: spec.timeout_ms ?? 8000,
          };
    nextIds.add(id);
    const prev = existingById.get(id);
    const publicManaged = spec.is_public === undefined ? 0 : 1;
    const isPublic =
      spec.is_public === undefined
        ? (prev?.is_public ?? (spec.from === "hub" ? 1 : 0))
        : spec.is_public
          ? 1
          : 0;
    const publicUrl =
      spec.public_url === undefined
        ? (prev?.public_url ?? null)
        : spec.public_url;
    const next: MonitorConfigFields = {
      id,
      name: spec.name,
      probe_from: probe.from,
      probe_json: JSON.stringify(probe),
      public_url: publicUrl,
      interval_secs:
        spec.interval_secs ?? (spec.from === "agent" ? nodeIntervalSecs : 60),
      enabled: (spec.enabled ?? true) ? 1 : 0,
      is_public: isPublic,
      public_managed: publicManaged,
    };
    if (!prev || !MONITOR_CONFIG_KEYS.every((k) => prev[k] === next[k])) {
      statements.push(...buildMonitorUpsertStatements(next, now, nodeId));
    }

    if (spec.from === "agent" && next.enabled === 1 && spec.result) {
      const probeRes: ProbeResult = {
        ok: spec.result.ok,
        httpStatus: spec.result.http_status ?? null,
        latencyMs:
          spec.result.latency_ms === undefined ||
          spec.result.latency_ms === null
            ? null
            : round1(spec.result.latency_ms),
        error: spec.result.ok ? null : (spec.result.error ?? "Check failed"),
      };
      statements.push(
        buildMonitorResultStatement(
          {
            id,
            samples_json: prev?.samples_json ?? "[]",
            rollup_json: prev?.rollup_json ?? "{}",
          },
          probeRes,
          now,
        ),
      );
      observations.push({
        incidentKey: `monitor:${id}`,
        targetType: "monitor",
        targetId: id,
        label: `Monitor: ${next.name}`,
        failing: !probeRes.ok,
        summary: probeRes.ok
          ? monitorOkSummary(spec.type, probeRes)
          : (probeRes.error ?? "Check failed"),
        threshold: failureThreshold,
        targetMutedUntil: Math.max(
          prev?.muted_until ?? 0,
          maintenanceMuteUntil(activeMaintenances, "monitor", id),
        ),
      });
    }
  }

  for (const prev of existing) {
    if (!nextIds.has(prev.id)) {
      statements.push(
        {
          sql: "DELETE FROM alert_states WHERE target_type = 'monitor' AND target_id = ?1",
          params: [prev.id],
        },
        {
          sql: "DELETE FROM monitors WHERE id = ?1 AND managed_by_node_id = ?2",
          params: [prev.id, nodeId],
        },
      );
    }
  }

  return { statements, observations };
}

interface ManagedJobRow {
  key: string;
  label: string;
  schedule: string | null;
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

function buildManagedJobStatements(
  nodeId: string,
  specs: readonly NodeJobSnapshot[],
  existing: readonly ManagedJobRow[],
  now: number,
): { statements: SqlStatement[]; observations: AlertObservation[] } {
  const statements: SqlStatement[] = [];
  const observations: AlertObservation[] = [];
  const existingByKey = new Map(existing.map((row) => [row.key, row]));
  const nextKeys = new Set<string>();

  for (const spec of specs) {
    const key = `${nodeId}:${spec.key}`.slice(0, 64);
    nextKeys.add(key);
    const prev = existingByKey.get(key);
    const label = spec.label ?? prev?.label ?? spec.key;
    const schedule = spec.schedule === undefined ? null : spec.schedule;
    const createdAt = prev?.created_at ?? now;
    const startedAt =
      spec.status === "running" ? (prev?.started_at ?? now) : null;
    const lastRunAt =
      spec.last_run_at === undefined
        ? (prev?.last_run_at ?? null)
        : spec.last_run_at;
    const nextRunAt = spec.next_run_at === undefined ? null : spec.next_run_at;
    const durationMs =
      spec.duration_ms === undefined
        ? (prev?.last_duration_ms ?? null)
        : spec.duration_ms;
    const summary = spec.summary === undefined ? null : spec.summary;
    const detail = spec.detail === undefined ? null : spec.detail;

    if (!prev) {
      statements.push({
        sql: `INSERT INTO jobs (
                key, node_id, managed_by_node_id, ping_token_hash, label,
                schedule, interval_secs, grace_secs, muted_until, created_at,
                started_at, last_run_at, next_run_at, last_status,
                last_duration_ms, last_summary, last_detail
              ) VALUES (?1, ?2, ?2, NULL, ?3, ?4, NULL, 3600, 0, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
              ON CONFLICT(key) DO UPDATE SET
                node_id = excluded.node_id,
                managed_by_node_id = excluded.managed_by_node_id,
                ping_token_hash = NULL,
                label = excluded.label,
                schedule = excluded.schedule,
                interval_secs = NULL,
                started_at = excluded.started_at,
                last_run_at = excluded.last_run_at,
                next_run_at = excluded.next_run_at,
                last_status = excluded.last_status,
                last_duration_ms = excluded.last_duration_ms,
                last_summary = excluded.last_summary,
                last_detail = excluded.last_detail`,
        params: [
          key,
          nodeId,
          label,
          schedule,
          createdAt,
          startedAt,
          lastRunAt,
          nextRunAt,
          spec.status,
          durationMs,
          summary,
          detail,
        ],
      });
    } else if (
      prev.label !== label ||
      prev.schedule !== schedule ||
      prev.started_at !== startedAt ||
      prev.last_run_at !== lastRunAt ||
      prev.next_run_at !== nextRunAt ||
      prev.last_status !== spec.status ||
      prev.last_duration_ms !== durationMs ||
      prev.last_summary !== summary ||
      prev.last_detail !== detail
    ) {
      statements.push({
        sql: `UPDATE jobs
              SET label = ?1,
                  schedule = ?2,
                  started_at = ?3,
                  last_run_at = ?4,
                  next_run_at = ?5,
                  last_status = ?6,
                  last_duration_ms = ?7,
                  last_summary = ?8,
                  last_detail = ?9
              WHERE key = ?10`,
        params: [
          label,
          schedule,
          startedAt,
          lastRunAt,
          nextRunAt,
          spec.status,
          durationMs,
          summary,
          detail,
          key,
        ],
      });
    }

    const targetMutedUntil = prev?.muted_until ?? 0;
    if (spec.status === "fail" || spec.status === "overdue") {
      observations.push({
        incidentKey: `job:${key}`,
        targetType: "job",
        targetId: key,
        label: `Job: ${label}`,
        failing: true,
        summary:
          summary ?? (spec.status === "overdue" ? "Job overdue" : "Job failed"),
        threshold: 1,
        targetMutedUntil,
      });
    } else if (spec.status === "ok") {
      observations.push({
        incidentKey: `job:${key}`,
        targetType: "job",
        targetId: key,
        label: `Job: ${label}`,
        failing: false,
        summary: summary ?? "Job succeeded",
        threshold: 1,
        targetMutedUntil,
      });
    }
  }

  for (const prev of existing) {
    if (!nextKeys.has(prev.key)) {
      statements.push(
        {
          sql: "DELETE FROM alert_states WHERE target_type = 'job' AND target_id = ?1",
          params: [prev.key],
        },
        {
          sql: "DELETE FROM jobs WHERE key = ?1 AND managed_by_node_id = ?2",
          params: [prev.key, nodeId],
        },
      );
    }
  }

  return { statements, observations };
}

const utcDaysInMonth = (year: number, monthIndex: number): number =>
  new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();

export function trafficPeriodStart(nowSecs: number, resetDay: number): number {
  const day = Math.min(31, Math.max(1, Math.floor(resetDay)));
  const date = new Date(nowSecs * 1000);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const current = Math.floor(
    Date.UTC(year, month, Math.min(day, utcDaysInMonth(year, month))) / 1000,
  );
  if (nowSecs >= current) {
    return current;
  }
  const prevYear = month === 0 ? year - 1 : year;
  const prevMonth = month === 0 ? 11 : month - 1;

  return Math.floor(
    Date.UTC(
      prevYear,
      prevMonth,
      Math.min(day, utcDaysInMonth(prevYear, prevMonth)),
    ) / 1000,
  );
}

function computeNetworkMetrics(
  node: NodeIngestRow | null,
  rxBytes: number | null,
  txBytes: number | null,
  now: number,
): {
  rxBps: number | null;
  txBps: number | null;
  monthRx: number;
  monthTx: number;
  periodStart: number;
} {
  const periodStart = trafficPeriodStart(now, node?.traffic_reset_day ?? 1);
  const samePeriod = node !== null && node.traffic_period_start === periodStart;
  if (rxBytes === null || txBytes === null) {
    return {
      rxBps: null,
      txBps: null,
      monthRx: samePeriod ? node.month_rx_bytes : 0,
      monthTx: samePeriod ? node.month_tx_bytes : 0,
      periodStart,
    };
  }

  let rxBps: number | null = node?.rx_bps ?? null;
  let txBps: number | null = node?.tx_bps ?? null;
  if (node) {
    const { prev_rx_bytes, prev_tx_bytes, prev_net_at } = node;
    if (
      prev_rx_bytes !== null &&
      prev_tx_bytes !== null &&
      prev_net_at !== null &&
      now > prev_net_at &&
      rxBytes >= prev_rx_bytes &&
      txBytes >= prev_tx_bytes
    ) {
      const dt = now - prev_net_at;
      rxBps = (rxBytes - prev_rx_bytes) / dt;
      txBps = (txBytes - prev_tx_bytes) / dt;
    }
  }

  if (!samePeriod) {
    return { rxBps, txBps, monthRx: 0, monthTx: 0, periodStart };
  }
  const deltaRx =
    node.prev_rx_bytes === null
      ? 0
      : rxBytes >= node.prev_rx_bytes
        ? rxBytes - node.prev_rx_bytes
        : rxBytes;
  const deltaTx =
    node.prev_tx_bytes === null
      ? 0
      : txBytes >= node.prev_tx_bytes
        ? txBytes - node.prev_tx_bytes
        : txBytes;

  return {
    rxBps,
    txBps,
    monthRx: node.month_rx_bytes + deltaRx,
    monthTx: node.month_tx_bytes + deltaTx,
    periodStart,
  };
}

export async function ingestNodeReport(
  db: SqlDatabase,
  config: LoadedConfig,
  payload: NodeReportPayload,
  bearerToken: string,
  enrollHeader?: string,
): Promise<{ registered: boolean }> {
  const now = unixNow();
  const batchQueries: SqlStatement[] = [
    { sql: SELECT_SETTINGS_SQL },
    {
      sql: `SELECT id, label, token_hash, interval_secs, grace_secs, muted_until, is_public,
                   prev_rx_bytes, prev_tx_bytes, prev_net_at, rx_bps, tx_bps,
                   month_rx_bytes, month_tx_bytes, traffic_reset_day, traffic_period_start, spark_json
            FROM nodes WHERE id = ?1`,
      params: [payload.node_id],
    },
    {
      sql: `SELECT ${ALERT_STATE_COLUMNS} FROM alert_states WHERE target_type = 'node' AND target_id = ?1`,
      params: [payload.node_id],
    },
    { sql: SELECT_ACTIVE_MAINTENANCES_SQL, params: [now] },
  ];
  const monitorBatchIdx =
    payload.monitors === undefined ? -1 : batchQueries.length;
  if (payload.monitors !== undefined) {
    batchQueries.push(
      {
        sql: `SELECT id, name, probe_from, probe_json, public_url, interval_secs,
                     enabled, is_public, public_managed, muted_until, samples_json, rollup_json
              FROM monitors WHERE managed_by_node_id = ?1`,
        params: [payload.node_id],
      },
      {
        sql: `SELECT ${ALERT_STATE_COLUMNS} FROM alert_states
              WHERE target_type = 'monitor'
                AND target_id IN (SELECT id FROM monitors WHERE managed_by_node_id = ?1)`,
        params: [payload.node_id],
      },
    );
  }
  const jobBatchIdx = payload.jobs === undefined ? -1 : batchQueries.length;
  if (payload.jobs !== undefined) {
    batchQueries.push(
      {
        sql: `SELECT key, label, schedule, muted_until, created_at,
                     started_at, last_run_at, next_run_at, last_status, last_duration_ms,
                     last_summary, last_detail
              FROM jobs WHERE managed_by_node_id = ?1`,
        params: [payload.node_id],
      },
      {
        sql: `SELECT ${ALERT_STATE_COLUMNS} FROM alert_states
              WHERE target_type = 'job'
                AND target_id IN (SELECT key FROM jobs WHERE managed_by_node_id = ?1)`,
        params: [payload.node_id],
      },
    );
  }

  const [incomingHash, batchResults] = await Promise.all([
    sha256Hex(bearerToken),
    db.allBatch(batchQueries),
  ]);
  const settingRows = batchResults[0] as SettingRow[];
  const nodeRows = batchResults[1] as NodeIngestRow[];
  const existingAlertStates = batchResults[2] as AlertStateRow[];
  const activeMaintenanceRows = batchResults[3] as MaintenanceRow[];
  const managedMonitorRows = (
    monitorBatchIdx >= 0 ? batchResults[monitorBatchIdx] : []
  ) as ManagedMonitorRow[];
  const existingMonitorAlertStates = (
    monitorBatchIdx >= 0 ? batchResults[monitorBatchIdx + 1] : []
  ) as AlertStateRow[];
  const managedJobRows = (
    jobBatchIdx >= 0 ? batchResults[jobBatchIdx] : []
  ) as ManagedJobRow[];
  const existingJobAlertStates = (
    jobBatchIdx >= 0 ? batchResults[jobBatchIdx + 1] : []
  ) as AlertStateRow[];
  const activeMaintenances = parseActiveMaintenances(activeMaintenanceRows);

  const settings = parseRuntimeSettings(settingRows, config);
  const existing = nodeRows[0] ?? null;

  if (existing) {
    if (!(await timingSafeEqualText(incomingHash, existing.token_hash))) {
      throw httpError(401, "Invalid node token");
    }
  } else {
    if (!settings.autoRegister) {
      throw httpError(
        401,
        "Node is not registered and auto-registration is off",
      );
    }
    if (!settings.enrollmentToken) {
      throw httpError(
        401,
        "Enrollment token is not configured for auto-registration",
      );
    }
    const candidateEnroll = enrollHeader?.trim() || bearerToken;
    if (
      !(await timingSafeEqualText(candidateEnroll, settings.enrollmentToken))
    ) {
      throw httpError(401, "Invalid enrollment token for auto-registration");
    }
  }

  const nodeId = payload.node_id;
  const label = payload.label ?? existing?.label ?? nodeId;
  const intervalSecs = payload.interval_secs ?? existing?.interval_secs ?? 60;
  const graceSecs = payload.grace_secs ?? existing?.grace_secs ?? 120;
  const mutedUntil = Math.max(
    existing?.muted_until ?? 0,
    maintenanceMuteUntil(activeMaintenances, "node", nodeId),
  );
  const rxBytes = payload.system?.rx_bytes ?? null;
  const txBytes = payload.system?.tx_bytes ?? null;
  const { rxBps, txBps, monthRx, monthTx, periodStart } = computeNetworkMetrics(
    existing,
    rxBytes,
    txBytes,
    now,
  );

  const mounts = payload.mounts ?? [];
  const checks = payload.checks ?? [];
  const series = payload.series ?? [];
  const info = payload.info ?? [];
  const publicManaged = payload.is_public === undefined ? 0 : 1;
  const isPublic =
    payload.is_public === undefined
      ? (existing?.is_public ?? 0)
      : payload.is_public
        ? 1
        : 0;

  const sampleValues: Record<string, number | [number, number]> = {};
  if (payload.system?.cpu_pct !== undefined) {
    sampleValues._cpu = round1(payload.system.cpu_pct);
  }
  if (payload.system?.load_1m !== undefined) {
    sampleValues._load = Math.round(payload.system.load_1m * 100) / 100;
  }
  const memPct = memPercent(payload.system ?? null);
  if (memPct !== null) {
    sampleValues._mem = round1(memPct);
  }
  if (rxBps !== null) {
    sampleValues._rx_bps = round1(rxBps);
  }
  if (txBps !== null) {
    sampleValues._tx_bps = round1(txBps);
  }
  for (const item of series) {
    const val = round1(item.value);
    sampleValues[item.key] =
      item.loss_pct === undefined ? val : [val, round1(item.loss_pct)];
  }
  const sparkJson = appendNodeSpark(existing?.spark_json, sampleValues, now);

  const systemJson = payload.system ? JSON.stringify(payload.system) : null;
  const mountsJson = JSON.stringify(mounts);
  const checksJson = JSON.stringify(checks);
  const seriesJson = JSON.stringify(series);
  const infoJson = JSON.stringify(info);
  const netAt = rxBytes === null ? null : now;
  const agentVersion = payload.agent_version ?? null;

  const statements: SqlStatement[] = [];
  if (existing) {
    const sets: string[] = [
      "interval_secs = ?1",
      "grace_secs = ?2",
      "public_managed = ?3",
      "last_seen_at = ?4",
      "prev_rx_bytes = ?5",
      "prev_tx_bytes = ?6",
      "prev_net_at = COALESCE(?7, prev_net_at)",
      "rx_bps = ?8",
      "tx_bps = ?9",
      "month_rx_bytes = ?10",
      "month_tx_bytes = ?11",
      "traffic_period_start = ?12",
      "system_json = ?13",
      "mounts_json = ?14",
      "checks_json = ?15",
      "series_json = ?16",
      "info_json = ?17",
      "spark_json = ?18",
      "agent_version = COALESCE(?19, agent_version)",
    ];
    const params: SqlParam[] = [
      intervalSecs,
      graceSecs,
      publicManaged,
      now,
      rxBytes,
      txBytes,
      netAt,
      rxBps,
      txBps,
      monthRx,
      monthTx,
      periodStart,
      systemJson,
      mountsJson,
      checksJson,
      seriesJson,
      infoJson,
      sparkJson,
      agentVersion,
    ];
    if (label !== existing.label) {
      params.push(label);
      sets.push(`label = ?${params.length}`);
    }
    if (publicManaged === 1 && isPublic !== existing.is_public) {
      params.push(isPublic);
      sets.push(`is_public = ?${params.length}`);
    }
    params.push(nodeId);
    statements.push({
      sql: `UPDATE nodes SET ${sets.join(", ")} WHERE id = ?${params.length}`,
      params,
    });
  } else {
    statements.push({
      sql: `INSERT INTO nodes (
              id, label, token_hash, interval_secs, grace_secs, is_public, public_managed, sort_order, created_at,
              last_seen_at, prev_rx_bytes, prev_tx_bytes, prev_net_at,
              rx_bps, tx_bps, month_rx_bytes, month_tx_bytes, traffic_period_start,
              system_json, mounts_json, checks_json, series_json, info_json, spark_json, agent_version
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, COALESCE((SELECT MAX(sort_order) + 1 FROM nodes), 0), ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24)`,
      params: [
        nodeId,
        label,
        incomingHash,
        intervalSecs,
        graceSecs,
        isPublic,
        publicManaged,
        now,
        now,
        rxBytes,
        txBytes,
        netAt,
        rxBps,
        txBps,
        monthRx,
        monthTx,
        periodStart,
        systemJson,
        mountsJson,
        checksJson,
        seriesJson,
        infoJson,
        sparkJson,
        agentVersion,
      ],
    });
  }
  let monitorObservations: AlertObservation[] = [];
  if (payload.monitors !== undefined) {
    const managed = buildManagedMonitorStatements(
      nodeId,
      intervalSecs,
      graceSecs,
      settings.failureThreshold,
      payload.monitors,
      managedMonitorRows,
      activeMaintenances,
      now,
    );
    statements.push(...managed.statements);
    monitorObservations = managed.observations;
  }
  let jobObservations: AlertObservation[] = [];
  if (payload.jobs !== undefined) {
    const managedJobs = buildManagedJobStatements(
      nodeId,
      payload.jobs,
      managedJobRows,
      now,
    );
    statements.push(...managedJobs.statements);
    jobObservations = managedJobs.observations;
  }

  if (Object.keys(sampleValues).length > 0) {
    statements.push({
      sql: "INSERT OR REPLACE INTO node_samples (node_id, ts, values_json) VALUES (?1, ?2, ?3)",
      params: [nodeId, Math.floor(now / 60) * 60, JSON.stringify(sampleValues)],
    });
  }

  const nodeObs = (
    suffix: string,
    subLabel: string,
    failing: boolean,
    summary: string,
    threshold = settings.failureThreshold,
  ): AlertObservation => ({
    incidentKey: `node:${nodeId}:${suffix}`,
    targetType: "node",
    targetId: nodeId,
    label: `${label}: ${subLabel}`,
    failing,
    summary,
    threshold,
    targetMutedUntil: mutedUntil,
  });

  const observations: AlertObservation[] = [
    nodeObs("offline", "Connectivity", false, "Node online", 1),
    ...mounts.map((m) =>
      nodeObs(
        `mount:${m.path}`,
        m.label ?? m.path,
        m.status === "fail",
        m.summary ??
          `${formatUsage(m.used_bytes, m.total_bytes)} (${(percent(m.used_bytes, m.total_bytes) ?? 0).toFixed(1)}%)`,
      ),
    ),
    ...checks.map((c) =>
      nodeObs(
        `check:${c.key}`,
        c.label,
        c.status === "fail",
        c.summary ?? c.status,
      ),
    ),
    ...series
      .filter((s) => s.status !== undefined)
      .map((s) =>
        nodeObs(
          `series:${s.key}`,
          s.label,
          s.status === "fail",
          s.summary ?? formatSeriesWithLoss(s.value, s.unit, s.loss_pct),
        ),
      ),
  ];

  statements.push(
    ...(await buildAlertStatements(
      config.publicBaseUrl,
      settings.notifications,
      observations,
      existingAlertStates,
      settings.globalMutedUntil,
      now,
      true,
    )),
  );
  if (monitorObservations.length > 0) {
    statements.push(
      ...(await buildAlertStatements(
        config.publicBaseUrl,
        settings.notifications,
        monitorObservations,
        existingMonitorAlertStates,
        settings.globalMutedUntil,
        now,
        false,
      )),
    );
  }
  if (jobObservations.length > 0) {
    statements.push(
      ...(await buildAlertStatements(
        config.publicBaseUrl,
        settings.notifications,
        jobObservations,
        existingJobAlertStates,
        settings.globalMutedUntil,
        now,
        false,
      )),
    );
  }

  await db.batch(statements);

  return { registered: existing === null };
}
