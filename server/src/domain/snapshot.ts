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
  MonitorSample,
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
import type { SettingRow } from "./settings.ts";
import { SELECT_SETTINGS_SQL, parseRuntimeSettings } from "./settings.ts";

interface SnapshotNodeRow {
  id: string;
  label: string;
  is_public: number;
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

interface RawSeriesSample {
  node_id: string;
  series_key: string;
  ts: number;
  value: number;
  aux_value: number | null;
}

interface RawMonitorSample {
  monitor_id: string;
  ts: number;
  ok: number;
  latency_ms: number | null;
}

const SPARK_WINDOW_SECS = 6 * 3600;
const MAX_SERIES_POINTS = 48;
const MAX_DETAIL_POINTS = 72;

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

function groupSeriesHistory(
  rows: readonly RawSeriesSample[],
  maxPoints = MAX_SERIES_POINTS,
): Map<string, Record<string, SeriesPoint[]>> {
  const byNode = new Map<string, Record<string, SeriesPoint[]>>();
  for (const s of rows) {
    let hist = byNode.get(s.node_id);
    if (!hist) {
      hist = {};
      byNode.set(s.node_id, hist);
    }
    (hist[s.series_key] ??= []).push({
      ts: s.ts,
      value: s.value,
      aux: s.aux_value,
    });
  }
  for (const hist of byNode.values()) {
    for (const [key, pts] of Object.entries(hist)) {
      pts.sort((a, b) => a.ts - b.ts);
      hist[key] = downsampleSeries(pts, maxPoints);
    }
  }

  return byNode;
}

function groupMonitorSamples(
  rows: readonly RawMonitorSample[],
): Map<string, MonitorSample[]> {
  const byMonitor = new Map<string, MonitorSample[]>();
  for (const r of rows) {
    let list = byMonitor.get(r.monitor_id);
    if (!list) {
      list = [];
      byMonitor.set(r.monitor_id, list);
    }
    list.push({ ts: r.ts, ok: r.ok === 1, latency_ms: r.latency_ms });
  }
  for (const list of byMonitor.values()) {
    list.sort((a, b) => a.ts - b.ts);
  }

  return byMonitor;
}

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
    seriesRows,
    monSampleRows,
  ] = (await db.allBatch([
    { sql: SELECT_SETTINGS_SQL },
    {
      sql: "SELECT id, name, device_type, backed_up, created_at, last_used_at FROM admin_passkeys ORDER BY created_at DESC",
    },
    {
      sql: `SELECT id, label, is_public, interval_secs, grace_secs, muted_until, created_at,
                   last_seen_at, rx_bps, tx_bps, system_json, mounts_json, checks_json,
                   series_json, info_json, agent_version
            FROM nodes ORDER BY id ASC`,
    },
    { sql: "SELECT * FROM monitors ORDER BY name ASC" },
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
      sql: `WITH wanted(node_id, series_key) AS (
              SELECT id, '_cpu' FROM nodes
              UNION ALL SELECT id, '_mem' FROM nodes
              UNION ALL SELECT id, '_rx_bps' FROM nodes
              UNION ALL SELECT id, '_tx_bps' FROM nodes
              UNION ALL SELECT n.id, json_extract(j.value, '$.key') FROM nodes n, json_each(n.series_json) j
            )
            SELECT s.node_id, s.series_key, s.ts, s.value, s.aux_value
            FROM wanted w
            CROSS JOIN series_samples s
              ON s.node_id = w.node_id AND s.series_key = w.series_key AND s.ts >= ?1`,
      params: [sparkCutoff],
    },
    {
      sql: `SELECT s.monitor_id, s.ts, s.ok, s.latency_ms
            FROM monitors m
            CROSS JOIN monitor_samples s
              ON s.monitor_id = m.id
             AND s.ts >= COALESCE(
               (SELECT s2.ts FROM monitor_samples s2
                WHERE s2.monitor_id = m.id
                ORDER BY s2.monitor_id DESC, s2.ts DESC LIMIT 1 OFFSET 47),
               0
             )`,
    },
  ])) as [
    SettingRow[],
    (Omit<PasskeySummary, "backed_up"> & { backed_up: number })[],
    SnapshotNodeRow[],
    MonitorRow[],
    JobRow[],
    IncidentSummary[],
    (Omit<AlertEventSummary, "delivery"> & { delivery_json: string })[],
    RawSeriesSample[],
    RawMonitorSample[],
  ];

  const settings = parseRuntimeSettings(settingRows, config);
  const passkeys: PasskeySummary[] = passkeyRows.map(
    ({ backed_up, ...rest }) => ({
      ...rest,
      backed_up: backed_up === 1,
    }),
  );
  const historyByNode = groupSeriesHistory(seriesRows);
  const samplesByMonitor = groupMonitorSamples(monSampleRows);

  const nodes: NodeSummary[] = nodeRows.map((row) => {
    const {
      is_public,
      system_json,
      mounts_json,
      checks_json,
      series_json,
      info_json,
      ...rest
    } = row;
    const system = system_json
      ? (JSON.parse(system_json) as SystemSnapshot)
      : null;
    const mounts = JSON.parse(mounts_json) as MountSnapshot[];
    const checks = JSON.parse(checks_json) as CheckSnapshot[];
    const series = JSON.parse(series_json) as SeriesSnapshot[];
    const info = JSON.parse(info_json) as InfoSnapshot[];

    return {
      ...rest,
      is_public: is_public === 1,
      overall_status: deriveNodeStatus(row, mounts, checks, series, now),
      system,
      mounts,
      checks,
      series,
      info,
      history: historyByNode.get(row.id) ?? {},
    };
  });

  const monitors: MonitorSummary[] = monitorRows.map(
    ({ created_at: _c, enabled, is_public, last_status, ...rest }) => ({
      ...rest,
      enabled: enabled === 1,
      is_public: is_public === 1,
      last_status:
        last_status === "ok" || last_status === "fail"
          ? last_status
          : "pending",
      samples: samplesByMonitor.get(rest.id) ?? [],
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
  const [nodeRows, seriesRows] = (await db.allBatch([
    {
      sql: "SELECT id FROM nodes WHERE id = ?1",
      params: [nodeId],
    },
    {
      sql: `WITH wanted(series_key) AS (
              SELECT '_cpu'
              UNION ALL SELECT '_mem'
              UNION ALL SELECT '_rx_bps'
              UNION ALL SELECT '_tx_bps'
              UNION ALL SELECT json_extract(j.value, '$.key')
              FROM nodes n, json_each(n.series_json) j
              WHERE n.id = ?1
            )
            SELECT s.node_id, s.series_key, s.ts, s.value, s.aux_value
            FROM wanted w
            CROSS JOIN series_samples s
              ON s.node_id = ?1 AND s.series_key = w.series_key AND s.ts >= ?2`,
      params: [nodeId, cutoff],
    },
  ])) as [{ id: string }[], RawSeriesSample[]];

  if (nodeRows.length === 0) {
    return null;
  }

  const history =
    groupSeriesHistory(seriesRows, MAX_DETAIL_POINTS).get(nodeId) ?? {};

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
  const [passkeyCountRows, monitorRows, nodeRows, seriesRows, monSampleRows] =
    (await db.allBatch([
      { sql: "SELECT COUNT(*) AS count FROM admin_passkeys" },
      {
        sql: `SELECT id, name, enabled, last_checked_at, last_status, last_http_status, last_latency_ms
              FROM monitors WHERE is_public = 1 ORDER BY name ASC`,
      },
      {
        sql: `SELECT id, label, interval_secs, grace_secs, last_seen_at,
                     system_json, mounts_json, checks_json, series_json
              FROM nodes WHERE is_public = 1 ORDER BY label ASC`,
      },
      {
        sql: `SELECT s.node_id, s.series_key, s.ts, s.value, NULL AS aux_value
              FROM nodes n
              CROSS JOIN series_samples s
                ON s.node_id = n.id
               AND s.series_key IN ('_cpu', '_mem')
               AND s.ts >= ?1
              WHERE n.is_public = 1`,
        params: [sparkCutoff],
      },
      {
        sql: `SELECT s.monitor_id, s.ts, s.ok, s.latency_ms
              FROM monitors m
              CROSS JOIN monitor_samples s
                ON s.monitor_id = m.id
               AND s.ts >= COALESCE(
                 (SELECT s2.ts FROM monitor_samples s2
                  WHERE s2.monitor_id = m.id
                  ORDER BY s2.monitor_id DESC, s2.ts DESC LIMIT 1 OFFSET 35),
                 0
               )
              WHERE m.is_public = 1`,
      },
    ])) as [
      { count: number }[],
      Pick<
        MonitorRow,
        | "id"
        | "name"
        | "enabled"
        | "last_checked_at"
        | "last_status"
        | "last_http_status"
        | "last_latency_ms"
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
      RawSeriesSample[],
      RawMonitorSample[],
    ];

  const historyByNode = groupSeriesHistory(seriesRows);
  const samplesByMonitor = groupMonitorSamples(monSampleRows);

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
        samples: samplesByMonitor.get(row.id) ?? [],
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
