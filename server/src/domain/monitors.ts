import type { SqlDatabase, SqlStatement } from "../db/index.ts";
import { errorMessage, httpError, readBoundedText } from "../http.ts";
import type { MonitorInput, MonitorSample } from "../shared/index.ts";
import { unixNow } from "../shared/index.ts";
import { parseMonitorInput } from "../validation.ts";

export interface MonitorConfigFields {
  id: string;
  name: string;
  url: string;
  public_url: string | null;
  method: string;
  expected_status_min: number;
  expected_status_max: number;
  expected_body: string | null;
  timeout_ms: number;
  interval_secs: number;
  enabled: number;
  is_public: number;
}

export interface MonitorRow extends MonitorConfigFields {
  managed_by_node_id: string | null;
  muted_until: number;
  created_at: number;
  last_checked_at: number | null;
  last_status: string | null;
  last_http_status: number | null;
  last_latency_ms: number | null;
  last_error: string | null;
  samples_json: string;
}

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

export interface ProbeResult {
  ok: boolean;
  httpStatus: number | null;
  latencyMs: number | null;
  error: string | null;
}

export function buildMonitorUpsertStatements(
  mon: MonitorConfigFields,
  now: number,
  managedByNodeId: string | null = null,
): SqlStatement[] {
  const statements: SqlStatement[] = [
    {
      sql: `INSERT INTO monitors
            (id, name, url, public_url, method, expected_status_min, expected_status_max, expected_body, timeout_ms, interval_secs, enabled, is_public, managed_by_node_id, sort_order, created_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, COALESCE((SELECT MAX(sort_order) + 1 FROM monitors), 0), ?14)
            ON CONFLICT(id) DO UPDATE SET
              last_checked_at = CASE
                WHEN monitors.url != excluded.url
                  OR monitors.method != excluded.method
                  OR monitors.expected_status_min != excluded.expected_status_min
                  OR monitors.expected_status_max != excluded.expected_status_max
                  OR monitors.expected_body IS NOT excluded.expected_body
                THEN NULL
                ELSE monitors.last_checked_at
              END,
              name = excluded.name,
              url = excluded.url,
              public_url = excluded.public_url,
              method = excluded.method,
              expected_status_min = excluded.expected_status_min,
              expected_status_max = excluded.expected_status_max,
              expected_body = excluded.expected_body,
              timeout_ms = excluded.timeout_ms,
              interval_secs = excluded.interval_secs,
              enabled = excluded.enabled,
              is_public = excluded.is_public,
              managed_by_node_id = excluded.managed_by_node_id`,
      params: [
        mon.id,
        mon.name,
        mon.url,
        mon.public_url,
        mon.method,
        mon.expected_status_min,
        mon.expected_status_max,
        mon.expected_body,
        mon.timeout_ms,
        mon.interval_secs,
        mon.enabled,
        mon.is_public,
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

export async function upsertMonitor(
  db: SqlDatabase,
  raw: MonitorInput | unknown,
): Promise<string> {
  const parsed = parseMonitorInput(raw);
  const existing = await db.first<{ managed_by_node_id: string | null }>(
    "SELECT managed_by_node_id FROM monitors WHERE id = ?1",
    [parsed.id],
  );
  if (existing?.managed_by_node_id) {
    throw httpError(
      409,
      `Monitor "${parsed.id}" is managed by node "${existing.managed_by_node_id}"`,
    );
  }
  await db.batch(
    buildMonitorUpsertStatements(
      {
        ...parsed,
        enabled: parsed.enabled ? 1 : 0,
        is_public: parsed.is_public ? 1 : 0,
      },
      unixNow(),
    ),
  );

  return parsed.id;
}

export async function probeMonitor(
  monitor: Pick<
    MonitorRow,
    | "url"
    | "method"
    | "expected_status_min"
    | "expected_status_max"
    | "expected_body"
    | "timeout_ms"
  >,
): Promise<ProbeResult> {
  const started = performance.now();
  try {
    const response = await fetch(monitor.url, {
      method: monitor.method,
      redirect: "follow",
      headers: { "User-Agent": "uptarn-probe/0.1" },
      signal: AbortSignal.timeout(monitor.timeout_ms),
    });
    const latencyMs = Math.round((performance.now() - started) * 10) / 10;
    if (
      response.status < monitor.expected_status_min ||
      response.status > monitor.expected_status_max
    ) {
      await response.body?.cancel();

      return {
        ok: false,
        httpStatus: response.status,
        latencyMs,
        error: `HTTP ${response.status}`,
      };
    }
    if (monitor.expected_body) {
      const bodyText = await readBoundedText(response, 65_536);
      if (!bodyText.includes(monitor.expected_body)) {
        return {
          ok: false,
          httpStatus: response.status,
          latencyMs,
          error: `Body missing "${monitor.expected_body.slice(0, 48)}"`,
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
      monitor.timeout_ms >= 1000 && monitor.timeout_ms % 1000 === 0
        ? `${monitor.timeout_ms / 1000}s`
        : `${monitor.timeout_ms}ms`;

    return {
      ok: false,
      httpStatus: null,
      latencyMs: Math.round((performance.now() - started) * 10) / 10,
      error: isTimeout ? `Timed out after ${timeoutLabel}` : rawError,
    };
  }
}
