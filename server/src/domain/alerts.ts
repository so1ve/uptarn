import type { LoadedConfig } from "../config.ts";
import type { SqlStatement } from "../db/index.ts";
import { errorMessage, readBoundedText } from "../http.ts";
import type { TargetType } from "../shared/index.ts";
import { formatDuration } from "../shared/index.ts";

export interface AlertPayload {
  kind: "firing" | "resolved";
  targetType: TargetType;
  targetId: string;
  label: string;
  summary: string;
  durationSecs?: number;
  dashboardUrl: string;
}

export interface AlertObservation {
  incidentKey: string;
  targetType: TargetType;
  targetId: string;
  label: string;
  failing: boolean;
  summary: string;
  threshold: number;
  targetMutedUntil: number;
}

export interface AlertStateRow {
  incident_key: string;
  target_type: TargetType;
  target_id: string;
  label: string;
  state: "failing" | "open";
  consecutive_failures: number;
  opened_at: number | null;
  notified_open: number;
  last_changed_at: number;
  last_summary: string;
}

export const ALERT_STATE_COLUMNS =
  "incident_key, target_type, target_id, label, state, consecutive_failures, opened_at, notified_open, last_changed_at, last_summary";

const escapeHtml = (text: string): string =>
  text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

function formatAlertBodies(alert: AlertPayload): {
  plain: string;
  html: string;
} {
  const tag = alert.kind === "firing" ? "FIRING" : "RESOLVED";
  const dur =
    alert.kind === "resolved" && alert.durationSecs !== undefined
      ? ` (after ${formatDuration(alert.durationSecs)})`
      : "";
  const url = escapeHtml(alert.dashboardUrl);

  return {
    plain: `[${tag}] ${alert.label}${dur}\n${alert.summary}\n${alert.dashboardUrl}`,
    html: `<b>[${tag}] ${escapeHtml(alert.label)}</b>${escapeHtml(dur)}\n<code>${escapeHtml(alert.summary)}</code>\n<a href="${url}">${url}</a>`,
  };
}

async function sendJson(url: string, init: RequestInit): Promise<void> {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(8000),
  });
  if (response.ok) {
    await response.body?.cancel();

    return;
  }
  const text = (await readBoundedText(response, 512)).trim();

  throw new Error(
    text ? `HTTP ${response.status}: ${text}` : `HTTP ${response.status}`,
  );
}

export async function dispatchNotifications(
  config: LoadedConfig,
  alert: AlertPayload,
): Promise<Record<string, string>> {
  const { plain, html } = formatAlertBodies(alert);
  const tasks: [string, Promise<void>][] = [];

  if (config.telegram) {
    tasks.push([
      "telegram",
      sendJson(
        `https://api.telegram.org/bot${config.telegram.botToken}/sendMessage`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: config.telegram.chatId,
            text: html,
            parse_mode: "HTML",
            disable_web_page_preview: true,
          }),
        },
      ),
    ]);
  }
  if (config.matrix) {
    const room = encodeURIComponent(config.matrix.roomId);
    const txn = encodeURIComponent(crypto.randomUUID());
    tasks.push([
      "matrix",
      sendJson(
        `${config.matrix.homeserver}/_matrix/client/v3/rooms/${room}/send/m.room.message/${txn}`,
        {
          method: "PUT",
          headers: {
            "Authorization": `Bearer ${config.matrix.accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            msgtype: "m.text",
            body: plain,
            format: "org.matrix.custom.html",
            formatted_body: html.replace(/\n/g, "<br/>"),
          }),
        },
      ),
    ]);
  }

  if (tasks.length === 0) {
    return { status: "no_channels_configured" };
  }

  const entries = await Promise.all(
    tasks.map(async ([name, promise]) => [
      name,
      await promise.then(
        () => "ok",
        (err: unknown) => `error: ${errorMessage(err)}`,
      ),
    ]),
  );

  return Object.fromEntries(entries) as Record<string, string>;
}

export const sendTestNotification = (
  config: LoadedConfig,
): Promise<Record<string, string>> =>
  dispatchNotifications(config, {
    kind: "resolved",
    targetType: "monitor",
    targetId: "test",
    label: "Uptarn test notification",
    summary: "Notification channel verification succeeded.",
    dashboardUrl: config.publicBaseUrl,
  });

export async function buildAlertStatements(
  config: LoadedConfig,
  observations: readonly AlertObservation[],
  existingStates: readonly AlertStateRow[],
  globalMutedUntil: number,
  now: number,
  pruneUnobserved = false,
): Promise<SqlStatement[]> {
  const byKey = new Map(existingStates.map((r) => [r.incident_key, r]));
  const deduped = new Map(observations.map((obs) => [obs.incidentKey, obs]));
  const statements: SqlStatement[] = [];

  if (pruneUnobserved) {
    for (const key of byKey.keys()) {
      if (!deduped.has(key)) {
        statements.push({
          sql: "DELETE FROM alert_states WHERE incident_key = ?1",
          params: [key],
        });
      }
    }
  }

  const notifications: { obs: AlertObservation; payload: AlertPayload }[] = [];

  for (const obs of deduped.values()) {
    const prev = byKey.get(obs.incidentKey);
    const isMuted = now < globalMutedUntil || now < obs.targetMutedUntil;

    if (obs.failing) {
      const failures = (prev?.consecutive_failures ?? 0) + 1;
      const nextState =
        failures >= Math.max(1, obs.threshold) ? "open" : "failing";
      const openedAt =
        nextState === "open"
          ? (prev?.opened_at ?? now)
          : (prev?.opened_at ?? null);
      let notifiedOpen = prev?.notified_open ?? 0;

      if (nextState === "open" && notifiedOpen === 0 && !isMuted) {
        notifiedOpen = 1;
        notifications.push({
          obs,
          payload: {
            kind: "firing",
            targetType: obs.targetType,
            targetId: obs.targetId,
            label: obs.label,
            summary: obs.summary,
            dashboardUrl: config.publicBaseUrl,
          },
        });
      }

      statements.push({
        sql: `INSERT INTO alert_states
              (incident_key, target_type, target_id, label, state, consecutive_failures, opened_at, notified_open, last_changed_at, last_summary)
              VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
              ON CONFLICT(incident_key) DO UPDATE SET
                label = excluded.label,
                state = excluded.state,
                consecutive_failures = excluded.consecutive_failures,
                opened_at = excluded.opened_at,
                notified_open = excluded.notified_open,
                last_changed_at = excluded.last_changed_at,
                last_summary = excluded.last_summary`,
        params: [
          obs.incidentKey,
          obs.targetType,
          obs.targetId,
          obs.label,
          nextState,
          failures,
          openedAt,
          notifiedOpen,
          prev?.state === nextState ? prev.last_changed_at : now,
          obs.summary,
        ],
      });
    } else if (prev) {
      if (prev.notified_open === 1 && !isMuted) {
        notifications.push({
          obs,
          payload: {
            kind: "resolved",
            targetType: obs.targetType,
            targetId: obs.targetId,
            label: obs.label,
            summary: obs.summary,
            durationSecs:
              prev.opened_at === null
                ? undefined
                : Math.max(0, now - prev.opened_at),
            dashboardUrl: config.publicBaseUrl,
          },
        });
      }

      statements.push({
        sql: "DELETE FROM alert_states WHERE incident_key = ?1",
        params: [obs.incidentKey],
      });
    }
  }

  if (notifications.length > 0) {
    const deliveries = await Promise.all(
      notifications.map(({ payload }) =>
        dispatchNotifications(config, payload),
      ),
    );
    for (const [idx, delivery] of deliveries.entries()) {
      const { obs, payload } = notifications[idx];
      statements.push({
        sql: `INSERT INTO alert_events (incident_key, target_type, target_id, label, kind, summary, created_at, delivery_json)
              VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
        params: [
          obs.incidentKey,
          obs.targetType,
          obs.targetId,
          obs.label,
          payload.kind,
          obs.summary,
          now,
          JSON.stringify(delivery),
        ],
      });
    }
  }

  return statements;
}
