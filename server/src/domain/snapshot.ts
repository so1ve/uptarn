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
import { unixNow } from "../shared/index.ts";
import type { JobRow } from "./jobs.ts";
import type { MonitorRow } from "./monitors.ts";
import { parseMonitorSamples } from "./monitors.ts";
import type { SettingRow } from "./settings.ts";
import { SELECT_SETTINGS_SQL, parseRuntimeSettings } from "./settings.ts";

interface SnapshotNodeRow {
  id: string;
  label: string;
  is_public: number;
  public_managed: number;
  interval_secs: number;
  grace_secs: number;
  muted_until: number;
  created_at: number;
  last_seen_at: number | null;
  rx_bps: number | null;
  tx_bps: number | null;
  system_json: string | null;
  mounts_json: string;
  checks_json: string;
  series_json: string;
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

function deriveNodeStatus(
  row: Pick<SnapshotNodeRow, "last_seen_at" | "interval_secs" | "grace_secs">,
  mounts: readonly MountSnapshot[],
  checks: readonly CheckSnapshot[],
  series: readonly SeriesSnapshot[],
  now: number,
): NodeSummary["overall_status"] {
  if (row.last_seen_at === null) {
    return "pending";
  }
  if (now > row.last_seen_at + row.interval_secs + row.grace_secs) {
    return "offline";
  }
  const statuses = [
    ...mounts.map((m) => m.status),
    ...checks.map((c) => c.status),
    ...series.flatMap((s) => (s.status ? [s.status] : [])),
  ];
  if (statuses.includes("fail")) {
    return "fail";
  }

  return statuses.includes("warn") ? "warn" : "ok";
}

function downsampleSeries(
  pts: SeriesPoint[],
  maxPoints = MAX_SERIES_POINTS,
): SeriesPoint[] {
  if (pts.length <= maxPoints) {
    return pts;
  }
  const last = pts.at(-1)!;
  const span = Math.max(1, last.ts - pts[0].ts);
  const step = Math.max(60, Math.ceil(span / maxPoints / 60) * 60);

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
        value: Math.round((sum / count) * 10) / 10,
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
      if (!allowed.has(key)) {
        continue;
      }
      const pt: SeriesPoint = Array.isArray(entry)
        ? { ts: row.ts, value: entry[0], aux: entry[1] }
        : { ts: row.ts, value: entry, aux: null };
      (hist[key] ??= []).push(pt);
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

function peakStoragePct(mounts: readonly MountSnapshot[]): number | null {
  if (mounts.length === 0) {
    return null;
  }
  if (mounts.some((m) => m.total_bytes === 0 && m.status === "fail")) {
    return 100;
  }
  const sized = mounts.filter((m) => m.total_bytes > 0);
  if (sized.length === 0) {
    return null;
  }

  return Math.max(
    ...sized.map((m) => Math.round((m.used_bytes / m.total_bytes) * 1000) / 10),
  );
}

export async function getDashboardSnapshot(
  db: SqlDatabase,
  config: LoadedConfig,
): Promise<DashboardSnapshot> {
  const now = unixNow();
  const sparkCutoff = now - SPARK_WINDOW_SECS;
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
      sql: `SELECT id, label, is_public, public_managed, interval_secs, grace_secs, muted_until, created_at,
                   last_seen_at, rx_bps, tx_bps, system_json, mounts_json, checks_json,
                   series_json, info_json, agent_version
            FROM nodes ORDER BY sort_order ASC, id ASC`,
    },
    { sql: "SELECT * FROM monitors ORDER BY sort_order ASC, name ASC" },
    { sql: "SELECT * FROM jobs ORDER BY key ASC" },
    {
      sql: `SELECT incident_key, target_type, target_id, label, state,
                   consecutive_failures, opened_at, last_changed_at, last_summary
            FROM alert_states
            ORDER BY state DESC, last_changed_at DESC`,
    },
    {
      sql: `SELECT id, incident_key, target_type, target_id, label, kind,
                   summary, created_at, delivery_json
            FROM alert_events ORDER BY created_at DESC LIMIT 40`,
    },
    {
      sql: `SELECT s.node_id, s.ts, s.values_json
            FROM nodes n
            CROSS JOIN node_samples s
              ON s.node_id = n.id AND s.ts >= ?1`,
      params: [sparkCutoff],
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
    system: row.system_json
      ? (JSON.parse(row.system_json) as SystemSnapshot)
      : null,
    mounts: JSON.parse(row.mounts_json) as MountSnapshot[],
    checks: JSON.parse(row.checks_json) as CheckSnapshot[],
    series: JSON.parse(row.series_json) as SeriesSnapshot[],
    info: JSON.parse(row.info_json) as InfoSnapshot[],
  }));

  const allowedKeysByNode = new Map(
    parsedNodes.map(({ row, series }) => [
      row.id,
      buildAllowedSeriesKeys(series),
    ]),
  );
  const historyByNode = groupNodeSamples(nodeSampleRows, allowedKeysByNode);

  const nodes: NodeSummary[] = parsedNodes.map(
    ({ row, system, mounts, checks, series, info }) => {
      const {
        is_public,
        public_managed,
        system_json: _s,
        mounts_json: _m,
        checks_json: _c,
        series_json: _se,
        info_json: _i,
        ...rest
      } = row;

      return {
        ...rest,
        is_public: is_public === 1,
        public_managed: public_managed === 1,
        overall_status: deriveNodeStatus(row, mounts, checks, series, now),
        system,
        mounts,
        checks,
        series,
        info,
        history: historyByNode.get(row.id) ?? {},
      };
    },
  );

  const monitors: MonitorSummary[] = monitorRows.map(
    ({
      created_at: _c,
      enabled,
      is_public,
      last_status,
      samples_json,
      ...rest
    }) => ({
      ...rest,
      enabled: enabled === 1,
      is_public: is_public === 1,
      last_status:
        last_status === "ok" || last_status === "fail"
          ? last_status
          : "pending",
      samples: parseMonitorSamples(samples_json),
    }),
  );

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

  const events: AlertEventSummary[] = eventRows.map(
    ({ delivery_json, ...rest }) => ({
      ...rest,
      delivery: JSON.parse(delivery_json) as Record<string, string>,
    }),
  );

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
      auth: {
        password_enabled: hasPasswordLogin(config),
        cf_access_enabled: config.cfAccess !== null,
        passkey_count: passkeys.length,
      },
    },
    incidents,
    nodes,
    monitors,
    jobs,
    events,
    passkeys,
  };
}

export async function getNodeHistory(
  db: SqlDatabase,
  nodeId: string,
  windowSecs: number,
): Promise<NodeHistoryResponse | null> {
  const now = unixNow();
  const cutoff = now - windowSecs;
  const [nodeRows, nodeSampleRows] = (await db.allBatch([
    {
      sql: "SELECT id, series_json FROM nodes WHERE id = ?1",
      params: [nodeId],
    },
    {
      sql: `SELECT node_id, ts, values_json
            FROM node_samples
            WHERE node_id = ?1 AND ts >= ?2
            ORDER BY ts ASC`,
      params: [nodeId, cutoff],
    },
  ])) as [{ id: string; series_json: string }[], RawNodeSample[]];

  const nodeRow = nodeRows[0];
  if (!nodeRow) {
    return null;
  }

  const series = JSON.parse(nodeRow.series_json) as SeriesSnapshot[];
  const allowedKeysByNode = new Map([[nodeId, buildAllowedSeriesKeys(series)]]);
  const history =
    groupNodeSamples(nodeSampleRows, allowedKeysByNode, MAX_DETAIL_POINTS).get(
      nodeId,
    ) ?? {};

  return {
    node_id: nodeId,
    window_secs: windowSecs,
    history,
  };
}

export async function getPublicStatusSnapshot(
  db: SqlDatabase,
  config: LoadedConfig,
): Promise<PublicStatusSnapshot> {
  const now = unixNow();
  const sparkCutoff = now - SPARK_WINDOW_SECS;
  const [passkeyCountRows, monitorRows, nodeRows, nodeSampleRows] =
    (await db.allBatch([
      { sql: "SELECT COUNT(*) AS count FROM admin_passkeys" },
      {
        sql: `SELECT id, name, public_url, enabled, last_checked_at, last_status, last_http_status, last_latency_ms, samples_json
              FROM monitors WHERE is_public = 1 ORDER BY sort_order ASC, name ASC`,
      },
      {
        sql: `SELECT id, label, interval_secs, grace_secs, last_seen_at,
                     system_json, mounts_json, checks_json, series_json
              FROM nodes WHERE is_public = 1 ORDER BY sort_order ASC, label ASC`,
      },
      {
        sql: `SELECT s.node_id, s.ts, s.values_json
              FROM nodes n
              CROSS JOIN node_samples s
                ON s.node_id = n.id AND s.ts >= ?1
              WHERE n.is_public = 1`,
        params: [sparkCutoff],
      },
    ])) as [
      { count: number }[],
      Pick<
        MonitorRow,
        | "id"
        | "name"
        | "public_url"
        | "enabled"
        | "last_checked_at"
        | "last_status"
        | "last_http_status"
        | "last_latency_ms"
        | "samples_json"
      >[],
      Pick<
        SnapshotNodeRow,
        | "id"
        | "label"
        | "interval_secs"
        | "grace_secs"
        | "last_seen_at"
        | "system_json"
        | "mounts_json"
        | "checks_json"
        | "series_json"
      >[],
      RawNodeSample[],
    ];

  const publicKeys = new Set(["_cpu", "_mem"]);
  const allowedKeysByNode = new Map(
    nodeRows.map((row) => [row.id, publicKeys]),
  );
  const historyByNode = groupNodeSamples(nodeSampleRows, allowedKeysByNode);

  return {
    now,
    version: manifest.version,
    public_base_url: config.publicBaseUrl,
    auth: {
      password_enabled: hasPasswordLogin(config),
      cf_access_enabled: config.cfAccess !== null,
      passkey_count: passkeyCountRows[0]?.count ?? 0,
    },
    monitors: monitorRows.map((row, idx) => {
      const status =
        row.last_status === "ok" || row.last_status === "fail"
          ? row.last_status
          : "pending";

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
              : "Unreachable"
            : null,
        samples: parseMonitorSamples(row.samples_json).slice(-36),
      };
    }),
    nodes: nodeRows.map((row, idx) => {
      const system = row.system_json
        ? (JSON.parse(row.system_json) as SystemSnapshot)
        : null;
      const mounts = JSON.parse(row.mounts_json) as MountSnapshot[];
      const checks = JSON.parse(row.checks_json) as CheckSnapshot[];
      const series = JSON.parse(row.series_json) as SeriesSnapshot[];
      const overallStatus = deriveNodeStatus(row, mounts, checks, series, now);
      const hist = historyByNode.get(row.id) ?? {};

      const memPct =
        system?.mem_used_bytes !== undefined &&
        system.mem_total_bytes !== undefined &&
        system.mem_total_bytes > 0
          ? Math.round(
              (system.mem_used_bytes / system.mem_total_bytes) * 1000,
            ) / 10
          : null;

      return {
        key: `n${idx}`,
        label: row.label,
        overall_status: overallStatus,
        uptime_secs:
          overallStatus === "offline" ? null : (system?.uptime_secs ?? null),
        cpu_pct: system?.cpu_pct ?? null,
        mem_pct: memPct,
        storage_pct: peakStoragePct(mounts),
        cpu_history: hist._cpu ?? [],
        mem_history: hist._mem ?? [],
      };
    }),
  };
}
