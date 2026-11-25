import {
  generateRandomToken,
  sha256Hex,
  timingSafeEqualText,
} from "../auth/index.ts";
import type { LoadedConfig } from "../config.ts";
import type { SqlDatabase, SqlStatement } from "../db/index.ts";
import { httpError } from "../http.ts";
import type {
  MonitorProbe,
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

  const [incomingHash, batchResults] = await Promise.all([
    sha256Hex(bearerToken),
    db.allBatch(batchQueries),
  ]);
  const [
    settingRows,
    nodeRows,
    existingAlertStates,
    activeMaintenanceRows,
    managedMonitorRows = [],
    existingMonitorAlertStates = [],
  ] = batchResults as [
    SettingRow[],
    NodeIngestRow[],
    AlertStateRow[],
    MaintenanceRow[],
    ManagedMonitorRow[]?,
    AlertStateRow[]?,
  ];
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

  const statements: SqlStatement[] = [
    {
      sql: `INSERT INTO nodes (
              id, label, token_hash, interval_secs, grace_secs, is_public, public_managed, sort_order, created_at,
              last_seen_at, prev_rx_bytes, prev_tx_bytes, prev_net_at,
              rx_bps, tx_bps, month_rx_bytes, month_tx_bytes, traffic_period_start,
              system_json, mounts_json, checks_json, series_json, info_json, spark_json, agent_version
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, COALESCE((SELECT MAX(sort_order) + 1 FROM nodes), 0), ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24)
            ON CONFLICT(id) DO UPDATE SET
              label = excluded.label,
              interval_secs = excluded.interval_secs,
              grace_secs = excluded.grace_secs,
              is_public = CASE WHEN excluded.public_managed = 1 THEN excluded.is_public ELSE nodes.is_public END,
              public_managed = excluded.public_managed,
              last_seen_at = excluded.last_seen_at,
              prev_rx_bytes = excluded.prev_rx_bytes,
              prev_tx_bytes = excluded.prev_tx_bytes,
              prev_net_at = COALESCE(excluded.prev_net_at, nodes.prev_net_at),
              rx_bps = excluded.rx_bps,
              tx_bps = excluded.tx_bps,
              month_rx_bytes = excluded.month_rx_bytes,
              month_tx_bytes = excluded.month_tx_bytes,
              traffic_period_start = excluded.traffic_period_start,
              system_json = excluded.system_json,
              mounts_json = excluded.mounts_json,
              checks_json = excluded.checks_json,
              series_json = excluded.series_json,
              info_json = excluded.info_json,
              spark_json = excluded.spark_json,
              agent_version = COALESCE(excluded.agent_version, nodes.agent_version)`,
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
        rxBytes === null ? null : now,
        rxBps,
        txBps,
        monthRx,
        monthTx,
        periodStart,
        payload.system ? JSON.stringify(payload.system) : null,
        JSON.stringify(mounts),
        JSON.stringify(checks),
        JSON.stringify(series),
        JSON.stringify(info),
        sparkJson,
        payload.agent_version ?? null,
      ],
    },
  ];
  let monitorObservations: AlertObservation[] = [];
  if (payload.monitors !== undefined) {
    const managed = buildManagedMonitorStatements(
      nodeId,
      intervalSecs,
      graceSecs,
      config.failureThreshold,
      payload.monitors,
      managedMonitorRows,
      activeMaintenances,
      now,
    );
    statements.push(...managed.statements);
    monitorObservations = managed.observations;
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
    threshold = config.failureThreshold,
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
      config,
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
        config,
        monitorObservations,
        existingMonitorAlertStates,
        settings.globalMutedUntil,
        now,
        false,
      )),
    );
  }

  await db.batch(statements);

  return { registered: existing === null };
}
