import type { SqlDatabase, SqlStatement } from "../db/index.ts";
import { httpError, readBoundedText } from "../http.ts";
import type {
  MonitorInput,
  MonitorKind,
  MonitorProbe,
  MonitorRollupBucket,
  MonitorRollups,
  MonitorSample,
} from "../shared/index.ts";
import { errorMessage, round1, unixNow } from "../shared/index.ts";
import { parseMonitorInput } from "../validation.ts";

export interface MonitorConfigFields {
  id: string;
  name: string;
  probe_from: MonitorProbe["from"];
  probe_json: string;
  public_url: string | null;
  interval_secs: number;
  enabled: number;
  is_public: number;
  public_managed: number;
}

export const MONITOR_CONFIG_KEYS = [
  "name",
  "probe_from",
  "probe_json",
  "public_url",
  "interval_secs",
  "enabled",
  "is_public",
  "public_managed",
] as const satisfies readonly (keyof MonitorConfigFields)[];

export interface MonitorRow extends MonitorConfigFields {
  group_name: string | null;
  managed_by_node_id: string | null;
  muted_until: number;
  created_at: number;
  last_checked_at: number | null;
  last_status: string | null;
  last_http_status: number | null;
  last_latency_ms: number | null;
  last_error: string | null;
  samples_json: string;
  rollup_json: string;
}

export const parseMonitorProbe = (raw: string): MonitorProbe =>
  JSON.parse(raw) as MonitorProbe;

type CompactMonitorSample = [ts: number, ok: 0 | 1, latency_ms: number | null];

export const MAX_MONITOR_SAMPLES = 48;

export function parseMonitorSamples(
  raw: string | null | undefined,
): MonitorSample[] {
  if (!raw) {
    return [];
  }

  return (JSON.parse(raw) as CompactMonitorSample[])
    .map(([ts, ok, latency_ms]) => ({ ts, ok: ok === 1, latency_ms }))
    .sort((a, b) => a.ts - b.ts);
}

export function appendMonitorSample(
  raw: string | null | undefined,
  sample: MonitorSample,
  limit = MAX_MONITOR_SAMPLES,
): string {
  const next = parseMonitorSamples(raw).filter((s) => s.ts !== sample.ts);
  next.push(sample);
  next.sort((a, b) => a.ts - b.ts);
  const compact: CompactMonitorSample[] = next
    .slice(-limit)
    .map((s) => [s.ts, s.ok ? 1 : 0, s.latency_ms]);

  return JSON.stringify(compact);
}

type CompactRollupBucket = [
  ts: number,
  ok: number,
  total: number,
  ms_sum: number,
  ms_cnt: number,
];

interface CompactRollups {
  m30?: CompactRollupBucket[];
  h6?: CompactRollupBucket[];
  d1?: CompactRollupBucket[];
}

const ROLLUP_SPECS = [
  { key: "m30", step: 1800, limit: 48 },
  { key: "h6", step: 21_600, limit: 28 },
  { key: "d1", step: 86_400, limit: 30 },
] as const;

function addSampleToCompact(
  rollup: CompactRollups,
  ts: number,
  ok: boolean,
  latencyMs: number | null,
): void {
  for (const { key, step, limit } of ROLLUP_SPECS) {
    const bucketTs = Math.floor(ts / step) * step;
    const minTs = bucketTs - (limit - 1) * step;
    const list = (rollup[key] ?? []).filter((b) => b[0] >= minTs);
    let bucket = list.find((b) => b[0] === bucketTs);
    if (!bucket) {
      bucket = [bucketTs, 0, 0, 0, 0];
      list.push(bucket);
    }
    bucket[2] += 1;
    if (ok) {
      bucket[1] += 1;
      if (latencyMs !== null) {
        bucket[3] += Math.round(latencyMs);
        bucket[4] += 1;
      }
    }
    list.sort((a, b) => a[0] - b[0]);
    rollup[key] = list.slice(-limit);
  }
}

function loadCompactRollups(
  raw: string | null | undefined,
  fallbackSamples?: readonly MonitorSample[],
): CompactRollups {
  const parsed = raw ? (JSON.parse(raw) as CompactRollups) : {};
  const hasData =
    (parsed.m30?.length ?? 0) > 0 ||
    (parsed.h6?.length ?? 0) > 0 ||
    (parsed.d1?.length ?? 0) > 0;
  if (!hasData && fallbackSamples && fallbackSamples.length > 0) {
    const seeded: CompactRollups = {};
    for (const s of fallbackSamples) {
      addSampleToCompact(seeded, s.ts, s.ok, s.latency_ms);
    }

    return seeded;
  }

  return parsed;
}

export function appendMonitorRollup(
  rawRollup: string | null | undefined,
  rawSamples: string | null | undefined,
  sample: MonitorSample,
): string {
  const rollup = loadCompactRollups(rawRollup, parseMonitorSamples(rawSamples));
  addSampleToCompact(rollup, sample.ts, sample.ok, sample.latency_ms);

  return JSON.stringify(rollup);
}

const toRollupBuckets = (
  list: readonly CompactRollupBucket[] | undefined,
): MonitorRollupBucket[] =>
  (list ?? [])
    .map(([ts, ok, total, msSum, msCnt]) => ({
      ts,
      ok,
      total,
      avg_ms: msCnt > 0 ? Math.round(msSum / msCnt) : null,
    }))
    .sort((a, b) => a.ts - b.ts);

export function parseMonitorRollups(
  raw: string | null | undefined,
  fallbackSamples?: readonly MonitorSample[],
): MonitorRollups {
  const compact = loadCompactRollups(raw, fallbackSamples);

  return {
    m30: toRollupBuckets(compact.m30),
    h6: toRollupBuckets(compact.h6),
    d1: toRollupBuckets(compact.d1),
  };
}

export interface ProbeResult {
  ok: boolean;
  httpStatus: number | null;
  latencyMs: number | null;
  error: string | null;
}

export function monitorOkSummary(kind: MonitorKind, res: ProbeResult): string {
  if (kind === "http") {
    return `HTTP ${res.httpStatus ?? 200} in ${res.latencyMs ?? 0} ms`;
  }
  if (kind === "tcp") {
    return res.latencyMs === null
      ? "TCP connected"
      : `TCP connected in ${res.latencyMs} ms`;
  }

  return res.latencyMs === null ? "OK" : `OK in ${res.latencyMs} ms`;
}

export function buildMonitorResultStatement(
  monitor: Pick<MonitorRow, "id" | "samples_json" | "rollup_json">,
  res: ProbeResult,
  now: number,
  options: { updateCheckedAt?: boolean } = {},
): SqlStatement {
  const sampleBucketTs = Math.floor(now / 30) * 30;
  const sample: MonitorSample = {
    ts: sampleBucketTs,
    ok: res.ok,
    latency_ms: res.latencyMs,
  };
  const samplesJson = appendMonitorSample(monitor.samples_json, sample);
  const rollupJson = appendMonitorRollup(
    monitor.rollup_json,
    monitor.samples_json,
    { ...sample, ts: now },
  );

  if (options.updateCheckedAt === false) {
    return {
      sql: `UPDATE monitors SET
              last_status = ?1, last_http_status = ?2,
              last_latency_ms = ?3, last_error = ?4, samples_json = ?5, rollup_json = ?6
            WHERE id = ?7`,
      params: [
        res.ok ? "ok" : "fail",
        res.httpStatus,
        res.latencyMs,
        res.error,
        samplesJson,
        rollupJson,
        monitor.id,
      ],
    };
  }

  return {
    sql: `UPDATE monitors SET
            last_checked_at = ?1, last_status = ?2, last_http_status = ?3,
            last_latency_ms = ?4, last_error = ?5, samples_json = ?6, rollup_json = ?7
          WHERE id = ?8`,
    params: [
      now,
      res.ok ? "ok" : "fail",
      res.httpStatus,
      res.latencyMs,
      res.error,
      samplesJson,
      rollupJson,
      monitor.id,
    ],
  };
}

export function buildMonitorUpsertStatements(
  mon: MonitorConfigFields,
  now: number,
  managedByNodeId: string | null = null,
  groupName: string | null = null,
): SqlStatement[] {
  const statements: SqlStatement[] = [
    {
      sql: `INSERT INTO monitors
            (id, name, group_name, probe_from, probe_json, public_url, interval_secs, enabled, is_public, public_managed, managed_by_node_id, sort_order, created_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, COALESCE((SELECT MAX(sort_order) + 1 FROM monitors), 0), ?12)
            ON CONFLICT(id) DO UPDATE SET
              last_checked_at = CASE
                WHEN monitors.probe_json != excluded.probe_json
                THEN NULL
                ELSE monitors.last_checked_at
              END,
              name = excluded.name,
              group_name = CASE
                WHEN excluded.managed_by_node_id IS NULL
                THEN excluded.group_name
                ELSE monitors.group_name
              END,
              probe_from = excluded.probe_from,
              probe_json = excluded.probe_json,
              public_url = excluded.public_url,
              interval_secs = excluded.interval_secs,
              enabled = excluded.enabled,
              is_public = CASE
                WHEN excluded.managed_by_node_id IS NULL OR excluded.public_managed = 1
                THEN excluded.is_public
                ELSE monitors.is_public
              END,
              public_managed = excluded.public_managed,
              managed_by_node_id = excluded.managed_by_node_id`,
      params: [
        mon.id,
        mon.name,
        groupName,
        mon.probe_from,
        mon.probe_json,
        mon.public_url,
        mon.interval_secs,
        mon.enabled,
        mon.is_public,
        mon.public_managed,
        managedByNodeId,
        now,
      ],
    },
  ];
  if (mon.enabled === 0) {
    statements.push({
      sql: "DELETE FROM alert_states WHERE target_type = 'monitor' AND target_id = ?1",
      params: [mon.id],
    });
  }

  return statements;
}

export async function assertMonitorHubManaged(
  db: SqlDatabase,
  monitorId: string,
): Promise<void> {
  const existing = await db.first<{ managed_by_node_id: string | null }>(
    "SELECT managed_by_node_id FROM monitors WHERE id = ?1",
    [monitorId],
  );
  if (existing?.managed_by_node_id) {
    throw httpError(
      409,
      `Monitor "${monitorId}" is managed by node "${existing.managed_by_node_id}"`,
    );
  }
}

export async function upsertMonitor(
  db: SqlDatabase,
  raw: MonitorInput | unknown,
): Promise<string> {
  const parsed = parseMonitorInput(raw);
  await assertMonitorHubManaged(db, parsed.id);
  const probe: MonitorProbe = {
    from: "hub",
    type: "http",
    url: parsed.url,
    method: parsed.method,
    expected_status_min: parsed.expected_status_min,
    expected_status_max: parsed.expected_status_max,
    expected_body: parsed.expected_body,
    timeout_ms: parsed.timeout_ms,
  };
  await db.batch(
    buildMonitorUpsertStatements(
      {
        id: parsed.id,
        name: parsed.name,
        probe_from: "hub",
        probe_json: JSON.stringify(probe),
        public_url: parsed.public_url,
        interval_secs: parsed.interval_secs,
        enabled: parsed.enabled ? 1 : 0,
        is_public: parsed.is_public ? 1 : 0,
        public_managed: 0,
      },
      unixNow(),
      null,
      parsed.group,
    ),
  );

  return parsed.id;
}

export async function updateMonitor(
  db: SqlDatabase,
  monitorId: string,
  patch: {
    is_public?: boolean;
    public_url?: string | null;
    group?: string | null;
  },
): Promise<boolean> {
  const existing = await db.first<{
    managed_by_node_id: string | null;
    public_managed: number;
  }>("SELECT managed_by_node_id, public_managed FROM monitors WHERE id = ?1", [
    monitorId,
  ]);
  if (!existing) {
    return false;
  }
  if (patch.is_public !== undefined && existing.public_managed === 1) {
    throw httpError(
      409,
      `Monitor "${monitorId}" visibility is managed by node "${existing.managed_by_node_id}"`,
    );
  }
  const sets: string[] = [];
  const params: (string | number | null)[] = [];
  if (patch.is_public !== undefined) {
    params.push(patch.is_public ? 1 : 0);
    sets.push(`is_public = ?${params.length}`);
  }
  if (patch.public_url !== undefined) {
    params.push(patch.public_url);
    sets.push(`public_url = ?${params.length}`);
  }
  if (patch.group !== undefined) {
    params.push(patch.group);
    sets.push(`group_name = ?${params.length}`);
  }
  params.push(monitorId);
  const res = await db.run(
    `UPDATE monitors SET ${sets.join(", ")} WHERE id = ?${params.length}`,
    params,
  );

  return res.changes > 0;
}

export async function probeMonitor(
  probe: Extract<MonitorProbe, { from: "hub" }>,
): Promise<ProbeResult> {
  const started = performance.now();
  try {
    const response = await fetch(probe.url, {
      method: probe.method,
      redirect: "follow",
      headers: { "User-Agent": "uptarn-probe/0.1" },
      signal: AbortSignal.timeout(probe.timeout_ms),
    });
    const latencyMs = round1(performance.now() - started);
    if (
      response.status < probe.expected_status_min ||
      response.status > probe.expected_status_max
    ) {
      await response.body?.cancel();

      return {
        ok: false,
        httpStatus: response.status,
        latencyMs,
        error: `HTTP ${response.status}`,
      };
    }
    if (probe.expected_body) {
      const bodyText = await readBoundedText(response, 65_536);
      if (!bodyText.includes(probe.expected_body)) {
        return {
          ok: false,
          httpStatus: response.status,
          latencyMs,
          error: `Body missing "${probe.expected_body.slice(0, 48)}"`,
        };
      }
    } else {
      await response.body?.cancel();
    }

    return { ok: true, httpStatus: response.status, latencyMs, error: null };
  } catch (error) {
    const rawError = errorMessage(error);
    const isTimeout =
      (error instanceof Error &&
        (error.name === "TimeoutError" || error.name === "AbortError")) ||
      /aborted due to timeout/i.test(rawError);
    const timeoutLabel =
      probe.timeout_ms >= 1000 && probe.timeout_ms % 1000 === 0
        ? `${probe.timeout_ms / 1000}s`
        : `${probe.timeout_ms}ms`;

    return {
      ok: false,
      httpStatus: null,
      latencyMs: round1(performance.now() - started),
      error: isTimeout ? `Timed out after ${timeoutLabel}` : rawError,
    };
  }
}
