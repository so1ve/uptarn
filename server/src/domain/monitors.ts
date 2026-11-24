import type { SqlDatabase, SqlStatement } from "../db/index.ts";
import { errorMessage, readBoundedText } from "../http.ts";
import type { MonitorInput } from "../shared/index.ts";
import { unixNow } from "../shared/index.ts";
import { parseMonitorInput } from "../validation.ts";

export interface MonitorRow {
  id: string;
  name: string;
  url: string;
  method: string;
  expected_status_min: number;
  expected_status_max: number;
  expected_body: string | null;
  timeout_ms: number;
  interval_secs: number;
  enabled: number;
  is_public: number;
  muted_until: number;
  created_at: number;
  last_checked_at: number | null;
  last_status: string | null;
  last_http_status: number | null;
  last_latency_ms: number | null;
  last_error: string | null;
}

export interface ProbeResult {
  ok: boolean;
  httpStatus: number | null;
  latencyMs: number | null;
  error: string | null;
}

export async function upsertMonitor(
  db: SqlDatabase,
  raw: MonitorInput | unknown,
): Promise<string> {
  const parsed = parseMonitorInput(raw);
  const statements: SqlStatement[] = [
    {
      sql: `INSERT INTO monitors
            (id, name, url, method, expected_status_min, expected_status_max, expected_body, timeout_ms, interval_secs, enabled, is_public, created_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
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
              method = excluded.method,
              expected_status_min = excluded.expected_status_min,
              expected_status_max = excluded.expected_status_max,
              expected_body = excluded.expected_body,
              timeout_ms = excluded.timeout_ms,
              interval_secs = excluded.interval_secs,
              enabled = excluded.enabled,
              is_public = excluded.is_public`,
      params: [
        parsed.id,
        parsed.name,
        parsed.url,
        parsed.method,
        parsed.expected_status_min,
        parsed.expected_status_max,
        parsed.expected_body,
        parsed.timeout_ms,
        parsed.interval_secs,
        parsed.enabled ? 1 : 0,
        parsed.is_public ? 1 : 0,
        unixNow(),
      ],
    },
  ];

  if (!parsed.enabled) {
    statements.push({
      sql: "DELETE FROM alert_states WHERE target_type = 'monitor' AND target_id = ?1",
      params: [parsed.id],
    });
  }

  await db.batch(statements);

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
    const statusOk =
      response.status >= monitor.expected_status_min &&
      response.status <= monitor.expected_status_max;

    if (!statusOk) {
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

    return {
      ok: true,
      httpStatus: response.status,
      latencyMs,
      error: null,
    };
  } catch (error) {
    return {
      ok: false,
      httpStatus: null,
      latencyMs: Math.round((performance.now() - started) * 10) / 10,
      error: errorMessage(error),
    };
  }
}
