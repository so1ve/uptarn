import manifest from "../../package.json" with { type: "json" };
import { hasPasswordLogin } from "../auth/index.ts";
import type { LoadedConfig } from "../config.ts";
import type { SqlDatabase } from "../db/index.ts";
import type {
  AlertEventSummary,
  CheckSnapshot,
  DashboardSnapshot,
  IncidentSummary,
  InfoSnapshot,
  JobSummary,
  MonitorSummary,
  MountSnapshot,
  NodeHistoryResponse,
  NodeSummary,
  PasskeySummary,
  PublicStatusSnapshot,
  SeriesPoint,
  SeriesSnapshot,
  SystemSnapshot,
} from "../shared/index.ts";
import {
  memPercent,
  round1,
  summarizeDisk,
  unixNow,
  worstHealthStatus,
} from "../shared/index.ts";
import type { JobRow } from "./jobs.ts";
import type { MonitorRow } from "./monitors.ts";
import {
  parseMonitorProbe,
  parseMonitorRollups,
  parseMonitorSamples,
} from "./monitors.ts";
import type { SettingRow } from "./settings.ts";
import { SELECT_SETTINGS_SQL, parseRuntimeSettings } from "./settings.ts";

interface NodeCoreRow {
  id: string;
  label: string;
  interval_secs: number;
  grace_secs: number;
  last_seen_at: number | null;
  system_json: string | null;
  mounts_json: string;
  checks_json: string;
  series_json: string;
  primary_mount: string | null;
}

interface SnapshotNodeRow extends NodeCoreRow {
  is_public: number;
  public_managed: number;
  muted_until: number;
  created_at: number;
  rx_bps: number | null;
  tx_bps: number | null;
  info_json: string;
  agent_version: string | null;
}

interface RawNodeSample {
  node_id: string;
  ts: number;
  values_json: string;
}

const SPARK_WINDOW_SECS = 6 * 3600;
const MAX_SERIES_POINTS = 48;
const MAX_DETAIL_POINTS = 72;
const BUILTIN_SERIES_KEYS = ["_cpu", "_mem", "_rx_bps", "_tx_bps"] as const;

function parseNodeCore(row: NodeCoreRow, now: number) {
  const system = row.system_json
    ? (JSON.parse(row.system_json) as SystemSnapshot)
    : null;
  const mounts = JSON.parse(row.mounts_json) as MountSnapshot[];
  const checks = JSON.parse(row.checks_json) as CheckSnapshot[];
  const series = JSON.parse(row.series_json) as SeriesSnapshot[];

  let overallStatus: NodeSummary["overall_status"];
  if (row.last_seen_at === null) {
    overallStatus = "pending";
  } else if (now > row.last_seen_at + row.interval_secs + row.grace_secs) {
    overallStatus = "offline";
  } else {
    overallStatus = worstHealthStatus([
      ...mounts.map((m) => m.status),
      ...checks.map((c) => c.status),
      ...series.flatMap((s) => (s.status ? [s.status] : [])),
    ]);
  }

  return { system, mounts, checks, series, overallStatus };
}

function downsampleSeries(
  pts: SeriesPoint[],
  maxPoints = MAX_SERIES_POINTS,
): SeriesPoint[] {
  if (pts.length <= maxPoints) {
    return pts;
  }
  const last = pts.at(-1)!;
  const step = Math.max(
    60,
    Math.ceil(Math.max(1, last.ts - pts[0].ts) / maxPoints / 60) * 60,
  );
  const buckets: SeriesPoint[] = [];
  let bucketTs = Math.floor(pts[0].ts / step) * step;
  let sum = 0;
  let count = 0;
  let maxAux: number | null = null;

  for (const pt of pts) {
    const nextBucket = Math.floor(pt.ts / step) * step;
    if (nextBucket !== bucketTs) {
      buckets.push({
        ts: bucketTs,
        value: round1(sum / count),
        aux: maxAux,
      });
      bucketTs = nextBucket;
      sum = 0;
      count = 0;
      maxAux = null;
    }
    sum += pt.value;
    count += 1;
    if (
      pt.aux !== undefined &&
      pt.aux !== null &&
      (maxAux === null || pt.aux > maxAux)
    ) {
      maxAux = pt.aux;
    }
  }
  buckets.push({ ts: last.ts, value: last.value, aux: maxAux });

  return buckets;
}

function groupNodeSamples(
  rows: readonly RawNodeSample[],
  allowedKeysByNode: Map<string, Set<string>>,
  maxPoints = MAX_SERIES_POINTS,
): Map<string, Record<string, SeriesPoint[]>> {
  const byNode = new Map<string, Record<string, SeriesPoint[]>>();
  for (const row of rows) {
    const allowed = allowedKeysByNode.get(row.node_id);
    if (!allowed || allowed.size === 0) {
      continue;
    }
    const parsed = JSON.parse(row.values_json) as Record<
      string,
      number | [number, number]
    >;
    let hist = byNode.get(row.node_id);
    if (!hist) {
      hist = {};
      byNode.set(row.node_id, hist);
    }
    for (const [key, entry] of Object.entries(parsed)) {
      if (allowed.has(key)) {
        (hist[key] ??= []).push(
          Array.isArray(entry)
            ? { ts: row.ts, value: entry[0], aux: entry[1] }
            : { ts: row.ts, value: entry, aux: null },
        );
      }
    }
  }
  for (const hist of byNode.values()) {
    for (const [key, pts] of Object.entries(hist)) {
      pts.sort((a, b) => a.ts - b.ts);
      hist[key] = downsampleSeries(pts, maxPoints);
    }
  }

  return byNode;
}

const buildAllowedSeriesKeys = (
  series: readonly SeriesSnapshot[],
): Set<string> =>
  new Set<string>([...BUILTIN_SERIES_KEYS, ...series.map((item) => item.key)]);

const monitorStatus = (raw: string | null): MonitorSummary["last_status"] =>
  raw === "ok" || raw === "fail" ? raw : "pending";

const buildAuthSummary = (config: LoadedConfig, passkeyCount: number) => ({
  password_enabled: hasPasswordLogin(config),
  cf_access_enabled: config.cfAccess !== null,
  passkey_count: passkeyCount,
});

function publicStoragePct(
  mounts: readonly MountSnapshot[],
  primaryMount: string | null,
): number | null {
  const disk = summarizeDisk(mounts, primaryMount);
  if (!disk) {
    return null;
  }
  if (disk.total_bytes === 0 && disk.status === "fail") {
    return 100;
  }

  return disk.pct === null ? null : round1(disk.pct);
}

export async function getDashboardSnapshot(
  db: SqlDatabase,
  config: LoadedConfig,
): Promise<DashboardSnapshot> {
  const now = unixNow();
  const [
    settingRows,
    passkeyRows,
    nodeRows,
    monitorRows,
    jobRows,
    incidents,
    eventRows,
    nodeSampleRows,
  ] = (await db.allBatch([
    { sql: SELECT_SETTINGS_SQL },
    {
      sql: "SELECT id, name, device_type, backed_up, created_at, last_used_at FROM admin_passkeys ORDER BY created_at DESC",
    },
    {
      sql: `SELECT id, label, is_public, public_managed, primary_mount, interval_secs, grace_secs, muted_until, created_at,
                   last_seen_at, rx_bps, tx_bps, system_json, mounts_json, checks_json, series_json, info_json, agent_version
            FROM nodes ORDER BY sort_order ASC, id ASC`,
    },
    { sql: "SELECT * FROM monitors ORDER BY sort_order ASC, name ASC" },
    { sql: "SELECT * FROM jobs ORDER BY key ASC" },
    {
      sql: `SELECT incident_key, target_type, target_id, label, state, consecutive_failures, opened_at, last_changed_at, last_summary
            FROM alert_states ORDER BY state DESC, last_changed_at DESC`,
    },
    {
      sql: `SELECT id, incident_key, target_type, target_id, label, kind, summary, created_at, delivery_json
            FROM alert_events ORDER BY created_at DESC LIMIT 40`,
    },
    {
      sql: "SELECT s.node_id, s.ts, s.values_json FROM nodes n CROSS JOIN node_samples s ON s.node_id = n.id AND s.ts >= ?1",
      params: [now - SPARK_WINDOW_SECS],
    },
  ])) as [
    SettingRow[],
    (Omit<PasskeySummary, "backed_up"> & { backed_up: number })[],
    SnapshotNodeRow[],
    MonitorRow[],
    JobRow[],
    IncidentSummary[],
    (Omit<AlertEventSummary, "delivery"> & { delivery_json: string })[],
    RawNodeSample[],
  ];

  const settings = parseRuntimeSettings(settingRows, config);
  const passkeys: PasskeySummary[] = passkeyRows.map(
    ({ backed_up, ...rest }) => ({
      ...rest,
      backed_up: backed_up === 1,
    }),
  );

  const parsedNodes = nodeRows.map((row) => ({
    row,
    ...parseNodeCore(row, now),
    info: JSON.parse(row.info_json) as InfoSnapshot[],
  }));
  const historyByNode = groupNodeSamples(
    nodeSampleRows,
    new Map(
      parsedNodes.map(({ row, series }) => [
        row.id,
        buildAllowedSeriesKeys(series),
      ]),
    ),
  );

  const nodes: NodeSummary[] = parsedNodes.map(
    ({ row, system, mounts, checks, series, info, overallStatus }) => ({
      id: row.id,
      label: row.label,
      overall_status: overallStatus,
      is_public: row.is_public === 1,
      public_managed: row.public_managed === 1,
      primary_mount: row.primary_mount,
      interval_secs: row.interval_secs,
      grace_secs: row.grace_secs,
      muted_until: row.muted_until,
      created_at: row.created_at,
      last_seen_at: row.last_seen_at,
      rx_bps: row.rx_bps,
      tx_bps: row.tx_bps,
      agent_version: row.agent_version,
      system,
      mounts,
      checks,
      series,
      info,
      history: historyByNode.get(row.id) ?? {},
    }),
  );

  const monitors: MonitorSummary[] = monitorRows.map((row) => {
    const samples = parseMonitorSamples(row.samples_json);

    return {
      id: row.id,
      name: row.name,
      probe: parseMonitorProbe(row.probe_json),
      public_url: row.public_url,
      interval_secs: row.interval_secs,
      enabled: row.enabled === 1,
      is_public: row.is_public === 1,
      managed_by_node_id: row.managed_by_node_id,
      muted_until: row.muted_until,
      last_checked_at: row.last_checked_at,
      last_status: monitorStatus(row.last_status),
      last_http_status: row.last_http_status,
      last_latency_ms: row.last_latency_ms,
      last_error: row.last_error,
      samples,
      rollups: parseMonitorRollups(row.rollup_json, samples),
    };
  });

  const jobs: JobSummary[] = jobRows.map(({ created_at: _c, ...row }) => {
    const nextDue = row.last_run_at + row.interval_secs;

    return {
      ...row,
      overall_status:
        row.last_status === "fail"
          ? "fail"
          : now > nextDue + row.grace_secs
            ? "overdue"
            : "ok",
      next_due_at: nextDue,
    };
  });

  return {
    now,
    version: manifest.version,
    public_base_url: config.publicBaseUrl,
    settings: {
      auto_register: settings.autoRegister,
      enrollment_token: settings.enrollmentToken,
      global_muted_until: settings.globalMutedUntil,
      channels: {
        telegram: config.telegram !== null,
        matrix: config.matrix !== null,
      },
      auth: buildAuthSummary(config, passkeys.length),
    },
    incidents,
    nodes,
    monitors,
    jobs,
    events: eventRows.map(({ delivery_json, ...rest }) => ({
      ...rest,
      delivery: JSON.parse(delivery_json) as Record<string, string>,
    })),
    passkeys,
  };
}

export async function getNodeHistory(
  db: SqlDatabase,
  nodeId: string,
  windowSecs: number,
): Promise<NodeHistoryResponse | null> {
  const [nodeRows, nodeSampleRows] = (await db.allBatch([
    {
      sql: "SELECT id, series_json FROM nodes WHERE id = ?1",
      params: [nodeId],
    },
    {
      sql: "SELECT node_id, ts, values_json FROM node_samples WHERE node_id = ?1 AND ts >= ?2",
      params: [nodeId, unixNow() - windowSecs],
    },
  ])) as [{ id: string; series_json: string }[], RawNodeSample[]];

  const nodeRow = nodeRows[0];
  if (!nodeRow) {
    return null;
  }
  const allowed = buildAllowedSeriesKeys(
    JSON.parse(nodeRow.series_json) as SeriesSnapshot[],
  );
  const history =
    groupNodeSamples(
      nodeSampleRows,
      new Map([[nodeId, allowed]]),
      MAX_DETAIL_POINTS,
    ).get(nodeId) ?? {};

  return { node_id: nodeId, window_secs: windowSecs, history };
}

export async function getPublicStatusSnapshot(
  db: SqlDatabase,
  config: LoadedConfig,
): Promise<PublicStatusSnapshot> {
  const now = unixNow();
  const [passkeyCountRows, monitorRows, nodeRows, nodeSampleRows] =
    (await db.allBatch([
      { sql: "SELECT COUNT(*) AS count FROM admin_passkeys" },
      {
        sql: `SELECT id, name, probe_json, public_url, enabled, last_checked_at, last_status, last_http_status, last_latency_ms, samples_json, rollup_json
            FROM monitors WHERE is_public = 1 ORDER BY sort_order ASC, name ASC`,
      },
      {
        sql: `SELECT id, label, primary_mount, interval_secs, grace_secs, last_seen_at, system_json, mounts_json, checks_json, series_json
            FROM nodes WHERE is_public = 1 ORDER BY sort_order ASC, label ASC`,
      },
      {
        sql: `SELECT s.node_id, s.ts, s.values_json FROM nodes n
            CROSS JOIN node_samples s ON s.node_id = n.id AND s.ts >= ?1
            WHERE n.is_public = 1`,
        params: [now - SPARK_WINDOW_SECS],
      },
    ])) as [{ count: number }[], MonitorRow[], NodeCoreRow[], RawNodeSample[]];

  const publicKeys = new Set<string>(["_cpu", "_mem"]);
  const historyByNode = groupNodeSamples(
    nodeSampleRows,
    new Map(nodeRows.map((row) => [row.id, publicKeys])),
  );

  return {
    now,
    version: manifest.version,
    public_base_url: config.publicBaseUrl,
    auth: buildAuthSummary(config, passkeyCountRows[0]?.count ?? 0),
    monitors: monitorRows.map((row, idx) => {
      const status = monitorStatus(row.last_status);
      const allSamples = parseMonitorSamples(row.samples_json);
      const probe = parseMonitorProbe(row.probe_json);

      return {
        key: `m${idx}`,
        name: row.name,
        public_url: row.public_url,
        enabled: row.enabled === 1,
        last_checked_at: row.last_checked_at,
        last_status: status,
        last_latency_ms: row.last_latency_ms,
        status_detail:
          status === "fail"
            ? row.last_http_status
              ? `HTTP ${row.last_http_status}`
              : probe.type === "exec"
                ? "Failed"
                : "Unreachable"
            : null,
        samples: allSamples.slice(-36),
        rollups: parseMonitorRollups(row.rollup_json, allSamples),
      };
    }),
    nodes: nodeRows.map((row, idx) => {
      const { system, mounts, overallStatus } = parseNodeCore(row, now);
      const hist = historyByNode.get(row.id) ?? {};
      const rawMemPct = memPercent(system);
      const memPct = rawMemPct === null ? null : round1(rawMemPct);

      return {
        key: `n${idx}`,
        label: row.label,
        overall_status: overallStatus,
        uptime_secs:
          overallStatus === "offline" ? null : (system?.uptime_secs ?? null),
        cpu_pct: system?.cpu_pct ?? null,
        mem_pct: memPct,
        storage_pct: publicStoragePct(mounts, row.primary_mount),
        cpu_history: hist._cpu ?? [],
        mem_history: hist._mem ?? [],
      };
    }),
  };
}
