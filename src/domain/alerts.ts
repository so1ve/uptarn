import { hmacSha256Hex } from "../auth/index.ts";
import type { SqlDatabase, SqlStatement } from "../db/index.ts";
import { readBoundedText } from "../http.ts";
import type { NotificationChannelName, TargetType } from "../shared/index.ts";
import {
  errorMessage,
  escapeHtml,
  formatDuration,
  incidentTargetPath,
  splitAlertLabel,
  unixNow,
} from "../shared/index.ts";
import type { ResolvedNotificationConfig } from "./settings.ts";

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
  acknowledged_at: number | null;
  notified_open: number;
  last_changed_at: number;
  last_summary: string;
}

export const ALERT_STATE_COLUMNS =
  "incident_key, target_type, target_id, label, state, consecutive_failures, opened_at, acknowledged_at, notified_open, last_changed_at, last_summary";

export async function setIncidentAcknowledged(
  db: SqlDatabase,
  incidentKey: string,
  acknowledged: boolean,
): Promise<{ found: boolean; acknowledged_at: number | null }> {
  const ackAt = acknowledged ? unixNow() : null;
  const res = await db.run(
    "UPDATE alert_states SET acknowledged_at = ?1 WHERE incident_key = ?2",
    [ackAt, incidentKey],
  );

  return { found: res.changes > 0, acknowledged_at: ackAt };
}

// Prevent Telegram from turning domain names inside alert titles into blue links.
const defangDomain = (text: string): string =>
  text.replace(/([a-z0-9])\.(?=[a-z0-9])/gi, "$1.\u200B");

function formatBatchBodies(alerts: readonly AlertPayload[]) {
  const first = alerts[0];
  const icon = first.kind === "firing" ? "🔴" : "🟢";
  const base = first.dashboardUrl.replace(/\/+$/, "");
  const allSameType = alerts.every((a) => a.targetType === first.targetType);
  const sameNode =
    allSameType &&
    first.targetType === "node" &&
    alerts.every((a) => a.targetId === first.targetId);
  const firstTitle = splitAlertLabel(first.targetType, first.label);
  const action = sameNode
    ? {
        label: `Open ${firstTitle.scope ?? first.targetId}`,
        url: `${base}${incidentTargetPath("node", first.targetId)}`,
      }
    : allSameType && first.targetType !== "node"
      ? {
          label: `Open ${first.targetType}s`,
          url: `${base}${incidentTargetPath(first.targetType, first.targetId)}`,
        }
      : { label: "Open dashboard", url: `${base}/admin` };

  let heading: string;
  let suffix = "";
  let plainBody: string;
  let telegramBody: string;
  let matrixBody: string;

  if (alerts.length === 1) {
    heading = firstTitle.scope
      ? `${firstTitle.scope} / ${firstTitle.subject}`
      : firstTitle.subject;
    if (first.kind === "resolved" && first.durationSecs !== undefined) {
      suffix = ` (recovered after ${formatDuration(first.durationSecs)})`;
    }
    plainBody = first.summary;
    telegramBody = escapeHtml(first.summary);
    matrixBody = telegramBody;
  } else {
    const sharedScope = sameNode ? firstTitle.scope : null;
    heading = sharedScope
      ? `${sharedScope} (${alerts.length} ${first.kind === "firing" ? "alerts" : "recovered"})`
      : `${alerts.length} alerts ${first.kind === "firing" ? "firing" : "recovered"}`;

    const plainLines: string[] = [];
    const htmlLines: string[] = [];
    for (const alert of alerts) {
      const { scope, subject } = splitAlertLabel(alert.targetType, alert.label);
      const name = sharedScope
        ? subject
        : scope
          ? `${scope} / ${subject}`
          : subject;
      const dur =
        alert.kind === "resolved" && alert.durationSecs !== undefined
          ? ` (${formatDuration(alert.durationSecs)})`
          : "";
      plainLines.push(`• ${name}${dur}: ${alert.summary}`);
      htmlLines.push(
        `• <b>${escapeHtml(defangDomain(name))}</b>${escapeHtml(dur)}: ${escapeHtml(alert.summary)}`,
      );
    }
    plainBody = plainLines.join("\n");
    telegramBody = htmlLines.join("\n");
    matrixBody = htmlLines.join("<br/>");
  }

  return {
    title: `${heading}${suffix}`,
    plain: `${icon} ${heading}${suffix}\n${plainBody}\n${action.url}`,
    telegramHtml: `${icon} <b>${escapeHtml(defangDomain(heading))}</b>${escapeHtml(suffix)}\n<blockquote>${telegramBody}</blockquote>`,
    matrixHtml: `${icon} <b>${escapeHtml(heading)}</b>${escapeHtml(suffix)}<br/><blockquote>${matrixBody}</blockquote><a href="${escapeHtml(action.url)}">${escapeHtml(action.label)}</a>`,
    action,
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

export async function dispatchNotificationBatch(
  channels: ResolvedNotificationConfig,
  alerts: readonly [AlertPayload, ...AlertPayload[]],
): Promise<Record<string, string>> {
  const { title, plain, telegramHtml, matrixHtml, action } =
    formatBatchBodies(alerts);
  const tasks: [string, Promise<void>][] = [];

  if (channels.telegram) {
    const body: Record<string, unknown> = {
      chat_id: channels.telegram.chatId,
      text: telegramHtml,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    };
    if (/^https?:\/\//i.test(action.url)) {
      body.reply_markup = {
        inline_keyboard: [[{ text: `${action.label} ↗`, url: action.url }]],
      };
    }
    tasks.push([
      "telegram",
      sendJson(
        `https://api.telegram.org/bot${channels.telegram.botToken}/sendMessage`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      ),
    ]);
  }
  if (channels.matrix) {
    const room = encodeURIComponent(channels.matrix.roomId);
    const txn = encodeURIComponent(crypto.randomUUID());
    tasks.push([
      "matrix",
      sendJson(
        `${channels.matrix.homeserver}/_matrix/client/v3/rooms/${room}/send/m.room.message/${txn}`,
        {
          method: "PUT",
          headers: {
            "Authorization": `Bearer ${channels.matrix.accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            msgtype: "m.text",
            body: plain,
            format: "org.matrix.custom.html",
            formatted_body: matrixHtml,
          }),
        },
      ),
    ]);
  }

  if (channels.webhook) {
    const { url, secret, headers: extraHeaders } = channels.webhook;
    const event = `alert.${alerts[0].kind}`;
    const body = JSON.stringify({
      event,
      kind: alerts[0].kind,
      title,
      text: plain,
      url: action.url,
      timestamp: unixNow(),
      alerts: alerts.map((a) => ({
        kind: a.kind,
        target_type: a.targetType,
        target_id: a.targetId,
        label: a.label,
        summary: a.summary,
        ...(a.durationSecs === undefined
          ? {}
          : { duration_secs: a.durationSecs }),
      })),
    });
    tasks.push([
      "webhook",
      (async () => {
        const headers = new Headers(extraHeaders);
        headers.set("Content-Type", "application/json");
        headers.set("X-Uptarn-Event", event);
        if (secret) {
          headers.set(
            "X-Uptarn-Signature-256",
            `sha256=${await hmacSha256Hex(secret, body)}`,
          );
        }
        await sendJson(url, { method: "POST", headers, body });
      })(),
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

export function sendTestNotification(
  publicBaseUrl: string,
  channels: ResolvedNotificationConfig,
  channel?: NotificationChannelName,
): Promise<Record<string, string>> {
  const targetChannels: ResolvedNotificationConfig = channel
    ? {
        telegram: channel === "telegram" ? channels.telegram : null,
        matrix: channel === "matrix" ? channels.matrix : null,
        webhook: channel === "webhook" ? channels.webhook : null,
      }
    : channels;

  return dispatchNotificationBatch(targetChannels, [
    {
      kind: "resolved",
      targetType: "monitor",
      targetId: "test",
      label: "Uptarn test notification",
      summary: "Notification channel verification succeeded.",
      dashboardUrl: publicBaseUrl,
    },
  ]);
}

const toAlertPayload = (
  obs: AlertObservation,
  kind: "firing" | "resolved",
  dashboardUrl: string,
  durationSecs?: number,
): AlertPayload => ({
  kind,
  targetType: obs.targetType,
  targetId: obs.targetId,
  label: obs.label,
  summary: obs.summary,
  durationSecs,
  dashboardUrl,
});

export async function buildAlertStatements(
  publicBaseUrl: string,
  channels: ResolvedNotificationConfig,
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
  const mutedEvents: { obs: AlertObservation; kind: "firing" | "resolved" }[] =
    [];
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

      if (nextState === "open" && notifiedOpen === 0) {
        if (!isMuted) {
          notifiedOpen = 1;
          notifications.push({
            obs,
            payload: toAlertPayload(obs, "firing", publicBaseUrl),
          });
        } else if (prev?.state !== "open") {
          mutedEvents.push({ obs, kind: "firing" });
        }
      }

      statements.push({
        sql: `INSERT INTO alert_states
              (incident_key, target_type, target_id, label, state, consecutive_failures, opened_at, notified_open, last_changed_at, last_summary)
              VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
              ON CONFLICT(incident_key) DO UPDATE SET
                label = excluded.label, state = excluded.state, consecutive_failures = excluded.consecutive_failures,
                opened_at = excluded.opened_at, notified_open = excluded.notified_open,
                last_changed_at = excluded.last_changed_at, last_summary = excluded.last_summary`,
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
        const dur =
          prev.opened_at === null
            ? undefined
            : Math.max(0, now - prev.opened_at);
        notifications.push({
          obs,
          payload: toAlertPayload(obs, "resolved", publicBaseUrl, dur),
        });
      } else if (prev.state === "open") {
        mutedEvents.push({ obs, kind: "resolved" });
      }
      statements.push({
        sql: "DELETE FROM alert_states WHERE incident_key = ?1",
        params: [obs.incidentKey],
      });
    }
  }

  const mutedDeliveryJson = JSON.stringify({ status: "muted" });
  for (const { obs, kind } of mutedEvents) {
    statements.push({
      sql: `INSERT INTO alert_events (incident_key, target_type, target_id, label, kind, summary, created_at, delivery_json)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
      params: [
        obs.incidentKey,
        obs.targetType,
        obs.targetId,
        obs.label,
        kind,
        obs.summary,
        now,
        mutedDeliveryJson,
      ],
    });
  }

  if (notifications.length > 0) {
    const batches = (["firing", "resolved"] as const)
      .map((kind) => notifications.filter((n) => n.payload.kind === kind))
      .filter((group) => group.length > 0);
    const deliveries = await Promise.all(
      batches.map((group) => {
        const payloads = group.map((item) => item.payload) as [
          AlertPayload,
          ...AlertPayload[],
        ];

        return dispatchNotificationBatch(channels, payloads);
      }),
    );
    for (const [idx, group] of batches.entries()) {
      const deliveryJson = JSON.stringify(deliveries[idx]);
      for (const { obs, payload } of group) {
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
            deliveryJson,
          ],
        });
      }
    }
  }

  return statements;
}
