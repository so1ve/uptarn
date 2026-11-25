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
  MonitorKind,
  MonitorSummary,
  MountSnapshot,
  NodeHistoryResponse,
  NodeSummary,
  PasskeySummary,
  PublicIncidentSummary,
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
import { parseNodeSpark } from "./nodes.ts";
import type { SettingRow } from "./settings.ts";
import { SELECT_SETTINGS_SQL, parseRuntimeSettings } from "./settings.ts";

interface NodeCoreRow {
  id: string;
  label: string;
  group_name: string | null;
  interval_secs: number;
  grace_secs: number;
  last_seen_at: number | null;
  system_json: string | null;
  mounts_json: string;
  checks_json: string;
  series_json: string;
  spark_json: string;
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

const MAX_DETAIL_POINTS = 72;
const BUILTIN_SERIES_KEYS = ["_cpu", "_mem", "_rx_bps", "_tx_bps"] as const;
const PUBLIC_SPARK_KEYS = new Set<string>(["_cpu", "_mem"]);

interface PublicAlertStateRow {
  incident_key: string;
  target_type: "monitor" | "node";
  target_id: string;
  opened_at: number | null;
  last_changed_at: number;
  last_summary: string;
}

interface PublicAlertEventRow {
  incident_key: string;
  target_type: "monitor" | "node";
  target_id: string;
  kind: "firing" | "resolved";
  summary: string;
  created_at: number;
}

function sanitizePublicReason(
  targetType: "monitor" | "node",
  summary: string,
  probeType?: MonitorKind,
): string {
  if (targetType === "node") {
    return "Offline";
  }
  const httpMatch = /^HTTP (\d{3})\b/.exec(summary);
  if (httpMatch) {
    return `HTTP ${httpMatch[1]}`;
  }
  if (/^Timed out\b/i.test(summary)) {
    return "Timed out";
  }

  return probeType === "exec" ? "Failed" : "Unreachable";
}

function buildPublicIncidents(
  openStates: readonly PublicAlertStateRow[],
  eventRows: readonly PublicAlertEventRow[],
  publicMonitors: ReadonlyMap<
    string,
    { key: string; name: string; probeType: MonitorKind }
  >,
  publicNodes: ReadonlyMap<string, { key: string; label: string }>,
): PublicIncidentSummary[] {
  function resolveTarget(
    targetType: "monitor" | "node",
    targetId: string,
    incidentKey: string,
  ): { targetKey: string; name: string; probeType?: MonitorKind } | null {
    if (targetType === "monitor") {
      const m = publicMonitors.get(targetId);

      return m
        ? { targetKey: m.key, name: m.name, probeType: m.probeType }
        : null;
    }
    if (incidentKey !== `node:${targetId}:offline`) {
      return null;
    }
    const n = publicNodes.get(targetId);

    return n ? { targetKey: n.key, name: n.label } : null;
  }

  const pendingFiring = new Map<
    string,
    { startedAt: number; reason: string }
  >();
  const resolved: Omit<PublicIncidentSummary, "key">[] = [];

  for (const ev of [...eventRows].reverse()) {
    const target = resolveTarget(ev.target_type, ev.target_id, ev.incident_key);
    if (!target) {
      continue;
    }
    if (ev.kind === "firing") {
      pendingFiring.set(ev.incident_key, {
        startedAt: ev.created_at,
        reason: sanitizePublicReason(
          ev.target_type,
          ev.summary,
          target.probeType,
        ),
      });
    } else {
      const started = pendingFiring.get(ev.incident_key);
      pendingFiring.delete(ev.incident_key);
      resolved.push({
        target_key: target.targetKey,
        target_type: ev.target_type,
        name: target.name,
        state: "resolved",
        started_at: started?.startedAt ?? ev.created_at,
        resolved_at: ev.created_at,
        reason:
          started?.reason ??
          sanitizePublicReason(ev.target_type, ev.summary, target.probeType),
      });
    }
  }

  const ongoing: Omit<PublicIncidentSummary, "key">[] = [];
  for (const st of openStates) {
    const target = resolveTarget(st.target_type, st.target_id, st.incident_key);
    if (!target) {
      continue;
    }
    const fired = pendingFiring.get(st.incident_key);
    ongoing.push({
      target_key: target.targetKey,
      target_type: st.target_type,
      name: target.name,
      state: "open",
      started_at: st.opened_at ?? fired?.startedAt ?? st.last_changed_at,
      resolved_at: null,
      reason: sanitizePublicReason(
        st.target_type,
        st.last_summary,
        target.probeType,
      ),
    });
  }

  ongoing.sort((a, b) => b.started_at - a.started_at);
  resolved.sort((a, b) => b.started_at - a.started_at);

  return [...ongoing, ...resolved].slice(0, 20).map((item, idx) => ({
    key: `i${idx}`,
    ...item,
  }));
}

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
  maxPoints = MAX_DETAIL_POINTS,
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
  maxPoints = MAX_DETAIL_POINTS,
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
  ] = (await db.allBatch([
    { sql: SELECT_SETTINGS_SQL },
    {
      sql: "SELECT id, name, device_type, backed_up, created_at, last_used_at FROM admin_passkeys ORDER BY created_at DESC",
    },
    {
      sql: `SELECT id, label, group_name, is_public, public_managed, primary_mount, interval_secs, grace_secs, muted_until, created_at,
                   last_seen_at, rx_bps, tx_bps, system_json, mounts_json, checks_json, series_json, info_json, spark_json, agent_version
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
  ])) as [
    SettingRow[],
    (Omit<PasskeySummary, "backed_up"> & { backed_up: number })[],
    SnapshotNodeRow[],
    MonitorRow[],
    JobRow[],
    IncidentSummary[],
    (Omit<AlertEventSummary, "delivery"> & { delivery_json: string })[],
  ];

  const settings = parseRuntimeSettings(settingRows, config);
  const passkeys: PasskeySummary[] = passkeyRows.map(
    ({ backed_up, ...rest }) => ({
      ...rest,
      backed_up: backed_up === 1,
    }),
  );

  const nodes: NodeSummary[] = nodeRows.map((row) => {
    const { system, mounts, checks, series, overallStatus } = parseNodeCore(
      row,
      now,
    );

    return {
      id: row.id,
      label: row.label,
      group: row.group_name ?? null,
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
      info: JSON.parse(row.info_json) as InfoSnapshot[],
      history: parseNodeSpark(
        row.spark_json,
        buildAllowedSeriesKeys(series),
        now,
      ),
    };
  });

  const monitors: MonitorSummary[] = monitorRows.map((row) => {
    const samples = parseMonitorSamples(row.samples_json);

    return {
      id: row.id,
      name: row.name,
      group: row.group_name ?? null,
      probe: parseMonitorProbe(row.probe_json),
      public_url: row.public_url,
      interval_secs: row.interval_secs,
      enabled: row.enabled === 1,
      is_public: row.is_public === 1,
      public_managed: row.public_managed === 1,
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
  const [
    passkeyCountRows,
    monitorRows,
    nodeRows,
    openAlertStates,
    recentAlertEvents,
  ] = (await db.allBatch([
    { sql: "SELECT COUNT(*) AS count FROM admin_passkeys" },
    {
      sql: `SELECT id, name, group_name, probe_json, public_url, enabled, last_checked_at, last_status, last_http_status, last_latency_ms, samples_json, rollup_json
            FROM monitors WHERE is_public = 1 ORDER BY sort_order ASC, name ASC`,
    },
    {
      sql: `SELECT id, label, group_name, primary_mount, interval_secs, grace_secs, last_seen_at, system_json, mounts_json, checks_json, series_json, spark_json
            FROM nodes WHERE is_public = 1 ORDER BY sort_order ASC, label ASC`,
    },
    {
      sql: `SELECT incident_key, target_type, target_id, opened_at, last_changed_at, last_summary
            FROM alert_states WHERE state = 'open' AND target_type IN ('monitor', 'node')`,
    },
    {
      sql: `SELECT incident_key, target_type, target_id, kind, summary, created_at
            FROM alert_events WHERE target_type IN ('monitor', 'node') ORDER BY created_at DESC LIMIT 60`,
    },
  ])) as [
    { count: number }[],
    MonitorRow[],
    NodeCoreRow[],
    PublicAlertStateRow[],
    PublicAlertEventRow[],
  ];

  const publicMonitorsById = new Map<
    string,
    { key: string; name: string; probeType: MonitorKind }
  >();
  const monitors = monitorRows.map((row, idx) => {
    const key = `m${idx}`;
    const status = monitorStatus(row.last_status);
    const allSamples = parseMonitorSamples(row.samples_json);
    const probe = parseMonitorProbe(row.probe_json);
    publicMonitorsById.set(row.id, {
      key,
      name: row.name,
      probeType: probe.type,
    });

    return {
      key,
      name: row.name,
      group: row.group_name ?? null,
      has_latency: probe.type !== "exec",
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
  });

  const publicNodesById = new Map<string, { key: string; label: string }>();
  const nodes = nodeRows.map((row, idx) => {
    const key = `n${idx}`;
    publicNodesById.set(row.id, { key, label: row.label });
    const { system, mounts, overallStatus } = parseNodeCore(row, now);
    const hist = parseNodeSpark(row.spark_json, PUBLIC_SPARK_KEYS, now);
    const rawMemPct = memPercent(system);
    const memPct = rawMemPct === null ? null : round1(rawMemPct);

    return {
      key,
      label: row.label,
      group: row.group_name ?? null,
      overall_status: overallStatus,
      uptime_secs:
        overallStatus === "offline" ? null : (system?.uptime_secs ?? null),
      cpu_pct: system?.cpu_pct ?? null,
      mem_pct: memPct,
      storage_pct: publicStoragePct(mounts, row.primary_mount),
      cpu_history: hist._cpu ?? [],
      mem_history: hist._mem ?? [],
    };
  });

  return {
    now,
    version: manifest.version,
    public_base_url: config.publicBaseUrl,
    auth: buildAuthSummary(config, passkeyCountRows[0]?.count ?? 0),
    monitors,
    nodes,
    incidents: buildPublicIncidents(
      openAlertStates,
      recentAlertEvents,
      publicMonitorsById,
      publicNodesById,
    ),
  };
}
