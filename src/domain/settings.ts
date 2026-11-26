import { generateRandomToken } from "../auth/index.ts";
import type {
  LoadedConfig,
  MatrixConfig,
  TelegramConfig,
  WebhookConfig,
} from "../config.ts";
import type { SqlDatabase, SqlStatement } from "../db/index.ts";
import { httpError } from "../http.ts";
import type {
  NotificationChannelsSummary,
  SecretSource,
  SiteLink,
  TargetType,
} from "../shared/index.ts";
import { unixNow } from "../shared/index.ts";
import type { NotificationSettingsPatch } from "../validation.ts";
import { assertJobHubManaged } from "./jobs.ts";
import { assertMonitorHubManaged } from "./monitors.ts";

export interface ResolvedNotificationConfig {
  telegram: TelegramConfig | null;
  matrix: MatrixConfig | null;
  webhook: WebhookConfig | null;
}

export interface RuntimeSettings {
  autoRegister: boolean;
  enrollmentToken: string | null;
  globalMutedUntil: number;
  siteTitle: string | null;
  siteLinks: SiteLink[];
  failureThreshold: number;
  retentionDays: number;
  notifications: ResolvedNotificationConfig;
  notificationSummary: NotificationChannelsSummary;
  lastPruneAt: number;
}

export interface SettingRow {
  key: string;
  value: string;
}

export const SELECT_SETTINGS_SQL = "SELECT key, value FROM system_settings";

export const buildChannelsFlags = (
  notifications: ResolvedNotificationConfig,
) => ({
  telegram: notifications.telegram !== null,
  matrix: notifications.matrix !== null,
  webhook: notifications.webhook !== null,
});

interface StoredTelegramOverride {
  enabled?: boolean;
  chat_id?: string | null;
  bot_token?: string;
}

interface StoredMatrixOverride {
  enabled?: boolean;
  homeserver?: string | null;
  room_id?: string | null;
  access_token?: string;
}

interface StoredWebhookOverride {
  enabled?: boolean;
  url?: string | null;
  secret?: string;
  headers?: Record<string, string>;
}

function parseStoredLinks(raw: string | undefined): SiteLink[] {
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as unknown;

    return Array.isArray(parsed)
      ? parsed.filter(
          (item): item is SiteLink =>
            typeof item === "object" &&
            item !== null &&
            typeof (item as SiteLink).label === "string" &&
            typeof (item as SiteLink).url === "string",
        )
      : [];
  } catch {
    return [];
  }
}

function parseStoredObject<T extends object>(raw: string | undefined): T {
  if (!raw) {
    return {} as T;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;

    return typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
      ? (parsed as T)
      : ({} as T);
  } catch {
    return {} as T;
  }
}

function parseBoundedInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);

  return Number.isFinite(parsed) && parsed >= min && parsed <= max
    ? parsed
    : fallback;
}

function sanitizeHeaders(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const name = k.trim();
    if (name && typeof v === "string") {
      out[name] = v;
    }
  }

  return out;
}

function resolveTelegram(
  stored: StoredTelegramOverride,
  envConfig: TelegramConfig | null,
) {
  const enabled =
    typeof stored.enabled === "boolean" ? stored.enabled : envConfig !== null;
  const chatId = Object.hasOwn(stored, "chat_id")
    ? typeof stored.chat_id === "string" && stored.chat_id.trim()
      ? stored.chat_id.trim()
      : null
    : (envConfig?.chatId ?? null);
  const dbToken =
    typeof stored.bot_token === "string" && stored.bot_token.trim()
      ? stored.bot_token.trim()
      : null;
  const botToken = dbToken ?? envConfig?.botToken ?? null;
  const botTokenSource: SecretSource = dbToken
    ? "db"
    : envConfig?.botToken
      ? "env"
      : null;
  const configured = Boolean(chatId && botToken);

  return {
    effective: enabled && chatId && botToken ? { botToken, chatId } : null,
    summary: {
      enabled,
      configured,
      chat_id: chatId,
      bot_token_source: botTokenSource,
    },
  };
}

function resolveMatrix(
  stored: StoredMatrixOverride,
  envConfig: MatrixConfig | null,
) {
  const enabled =
    typeof stored.enabled === "boolean" ? stored.enabled : envConfig !== null;
  const homeserver = Object.hasOwn(stored, "homeserver")
    ? typeof stored.homeserver === "string" && stored.homeserver.trim()
      ? stored.homeserver.trim().replace(/\/+$/, "")
      : null
    : (envConfig?.homeserver ?? null);
  const roomId = Object.hasOwn(stored, "room_id")
    ? typeof stored.room_id === "string" && stored.room_id.trim()
      ? stored.room_id.trim()
      : null
    : (envConfig?.roomId ?? null);
  const dbToken =
    typeof stored.access_token === "string" && stored.access_token.trim()
      ? stored.access_token.trim()
      : null;
  const accessToken = dbToken ?? envConfig?.accessToken ?? null;
  const accessTokenSource: SecretSource = dbToken
    ? "db"
    : envConfig?.accessToken
      ? "env"
      : null;
  const configured = Boolean(homeserver && roomId && accessToken);

  return {
    effective:
      enabled && homeserver && roomId && accessToken
        ? { homeserver, roomId, accessToken }
        : null,
    summary: {
      enabled,
      configured,
      homeserver,
      room_id: roomId,
      access_token_source: accessTokenSource,
    },
  };
}

function resolveWebhook(
  stored: StoredWebhookOverride,
  envConfig: WebhookConfig | null,
) {
  const enabled =
    typeof stored.enabled === "boolean" ? stored.enabled : envConfig !== null;
  const url = Object.hasOwn(stored, "url")
    ? typeof stored.url === "string" && stored.url.trim()
      ? stored.url.trim()
      : null
    : (envConfig?.url ?? null);
  const headers = Object.hasOwn(stored, "headers")
    ? sanitizeHeaders(stored.headers)
    : { ...(envConfig?.headers ?? {}) };
  const dbSecret =
    typeof stored.secret === "string" && stored.secret.trim()
      ? stored.secret.trim()
      : null;
  const secret = dbSecret ?? envConfig?.secret ?? null;
  const secretSource: SecretSource = dbSecret
    ? "db"
    : envConfig?.secret
      ? "env"
      : null;
  const configured = Boolean(url);

  return {
    effective: enabled && url ? { url, secret, headers } : null,
    summary: {
      enabled,
      configured,
      url,
      headers,
      secret_source: secretSource,
    },
  };
}

function parseRuntimeSettingsFromMap(
  map: ReadonlyMap<string, string>,
  config: LoadedConfig,
): RuntimeSettings {
  const autoRaw = map.get("auto_register");
  const telegram = resolveTelegram(
    parseStoredObject<StoredTelegramOverride>(map.get("notification_telegram")),
    config.telegram,
  );
  const matrix = resolveMatrix(
    parseStoredObject<StoredMatrixOverride>(map.get("notification_matrix")),
    config.matrix,
  );
  const webhook = resolveWebhook(
    parseStoredObject<StoredWebhookOverride>(map.get("notification_webhook")),
    config.webhook,
  );

  return {
    autoRegister:
      autoRaw === undefined ? config.defaultAutoRegister : autoRaw === "1",
    enrollmentToken:
      map.get("enrollment_token") || config.enrollmentToken || null,
    globalMutedUntil: Number.parseInt(map.get("global_muted_until") ?? "0", 10),
    siteTitle: map.get("site_title")?.trim() || null,
    siteLinks: parseStoredLinks(map.get("site_links")),
    failureThreshold: parseBoundedInt(
      map.get("failure_threshold"),
      config.failureThreshold,
      1,
      10,
    ),
    retentionDays: parseBoundedInt(
      map.get("retention_days"),
      config.retentionDays,
      1,
      365,
    ),
    notifications: {
      telegram: telegram.effective,
      matrix: matrix.effective,
      webhook: webhook.effective,
    },
    notificationSummary: {
      telegram: telegram.summary,
      matrix: matrix.summary,
      webhook: webhook.summary,
    },
    lastPruneAt: Number.parseInt(map.get("last_prune_at") ?? "0", 10),
  };
}

export const parseRuntimeSettings = (
  rows: readonly SettingRow[],
  config: LoadedConfig,
): RuntimeSettings =>
  parseRuntimeSettingsFromMap(
    new Map(rows.map((r) => [r.key, r.value])),
    config,
  );

export const upsertSettingStmt = (
  key: string,
  value: string,
  now: number,
): SqlStatement => ({
  sql: `INSERT INTO system_settings (key, value, updated_at)
        VALUES (?1, ?2, ?3)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  params: [key, value, now],
});

const deleteSettingStmt = (key: string): SqlStatement => ({
  sql: "DELETE FROM system_settings WHERE key = ?1",
  params: [key],
});

export async function updateRuntimeSettings(
  db: SqlDatabase,
  config: LoadedConfig,
  patch: {
    auto_register?: boolean;
    rotate_enrollment_token?: boolean;
    global_muted_until?: number;
    site_title?: string | null;
    site_links?: SiteLink[];
    failure_threshold?: number | null;
    retention_days?: number | null;
    notifications?: NotificationSettingsPatch;
  },
): Promise<RuntimeSettings> {
  const now = unixNow();
  const rows = await db.all<SettingRow>(SELECT_SETTINGS_SQL);
  const map = new Map(rows.map((r) => [r.key, r.value]));
  const current = parseRuntimeSettingsFromMap(map, config);
  const statements: SqlStatement[] = [];

  function setKey(key: string, value: string) {
    map.set(key, value);
    statements.push(upsertSettingStmt(key, value, now));
  }
  function delKey(key: string) {
    map.delete(key);
    statements.push(deleteSettingStmt(key));
  }

  if (patch.auto_register !== undefined) {
    setKey("auto_register", patch.auto_register ? "1" : "0");
  }

  if (
    patch.rotate_enrollment_token ||
    (patch.auto_register && !current.enrollmentToken)
  ) {
    setKey("enrollment_token", generateRandomToken("uptn_enroll"));
  }

  if (patch.global_muted_until !== undefined) {
    setKey(
      "global_muted_until",
      String(Math.max(0, Math.floor(patch.global_muted_until))),
    );
  }

  if (patch.site_title !== undefined) {
    setKey("site_title", patch.site_title ?? "");
  }

  if (patch.site_links !== undefined) {
    setKey("site_links", JSON.stringify(patch.site_links));
  }

  if (patch.failure_threshold !== undefined) {
    if (patch.failure_threshold === null) {
      delKey("failure_threshold");
    } else {
      setKey("failure_threshold", String(patch.failure_threshold));
    }
  }

  if (patch.retention_days !== undefined) {
    if (patch.retention_days === null) {
      delKey("retention_days");
    } else {
      setKey("retention_days", String(patch.retention_days));
    }
  }

  if (patch.notifications?.telegram) {
    const p = patch.notifications.telegram;
    const stored = parseStoredObject<StoredTelegramOverride>(
      map.get("notification_telegram"),
    );
    if (p.enabled !== undefined) {
      stored.enabled = p.enabled;
    }
    if (p.chat_id !== undefined) {
      stored.chat_id = p.chat_id;
    }
    if (p.bot_token !== undefined) {
      if (p.bot_token === null) {
        delete stored.bot_token;
      } else {
        stored.bot_token = p.bot_token;
      }
    }
    const resolved = resolveTelegram(stored, config.telegram);
    if (resolved.summary.enabled && !resolved.summary.configured) {
      throw httpError(
        400,
        "Telegram requires both a bot token and chat ID while enabled",
      );
    }
    setKey("notification_telegram", JSON.stringify(stored));
  }

  if (patch.notifications?.matrix) {
    const p = patch.notifications.matrix;
    const stored = parseStoredObject<StoredMatrixOverride>(
      map.get("notification_matrix"),
    );
    if (p.enabled !== undefined) {
      stored.enabled = p.enabled;
    }
    if (p.homeserver !== undefined) {
      stored.homeserver = p.homeserver;
    }
    if (p.room_id !== undefined) {
      stored.room_id = p.room_id;
    }
    if (p.access_token !== undefined) {
      if (p.access_token === null) {
        delete stored.access_token;
      } else {
        stored.access_token = p.access_token;
      }
    }
    const resolved = resolveMatrix(stored, config.matrix);
    if (resolved.summary.enabled && !resolved.summary.configured) {
      throw httpError(
        400,
        "Matrix requires homeserver, room ID, and access token while enabled",
      );
    }
    setKey("notification_matrix", JSON.stringify(stored));
  }

  if (patch.notifications?.webhook) {
    const p = patch.notifications.webhook;
    const stored = parseStoredObject<StoredWebhookOverride>(
      map.get("notification_webhook"),
    );
    if (p.enabled !== undefined) {
      stored.enabled = p.enabled;
    }
    if (p.url !== undefined) {
      stored.url = p.url;
    }
    if (p.secret !== undefined) {
      if (p.secret === null) {
        delete stored.secret;
      } else {
        stored.secret = p.secret;
      }
    }
    if (p.headers !== undefined) {
      if (p.headers === null) {
        delete stored.headers;
      } else {
        stored.headers = p.headers;
      }
    }
    const resolved = resolveWebhook(stored, config.webhook);
    if (resolved.summary.enabled && !resolved.summary.configured) {
      throw httpError(400, "Webhook requires a valid URL while enabled");
    }
    setKey("notification_webhook", JSON.stringify(stored));
  }

  if (statements.length > 0) {
    await db.batch(statements);
  }

  return parseRuntimeSettingsFromMap(map, config);
}

const TARGET_TABLE = {
  node: { table: "nodes", pk: "id" },
  monitor: { table: "monitors", pk: "id" },
  job: { table: "jobs", pk: "key" },
} as const satisfies Record<TargetType, { table: string; pk: string }>;

export async function setTargetMute(
  db: SqlDatabase,
  targetType: TargetType,
  targetId: string,
  mutedUntil: number,
): Promise<boolean> {
  const { table, pk } = TARGET_TABLE[targetType];
  const res = await db.run(
    `UPDATE ${table} SET muted_until = ?1 WHERE ${pk} = ?2`,
    [Math.max(0, Math.floor(mutedUntil)), targetId],
  );

  return res.changes > 0;
}

export async function reorderTargets(
  db: SqlDatabase,
  targetType: "node" | "monitor",
  ids: readonly string[],
): Promise<void> {
  const { table, pk } = TARGET_TABLE[targetType];
  await db.batch(
    ids.map((id, index) => ({
      sql: `UPDATE ${table} SET sort_order = ?1 WHERE ${pk} = ?2`,
      params: [index, id],
    })),
  );
}

export async function deleteTarget(
  db: SqlDatabase,
  targetType: TargetType,
  targetId: string,
): Promise<boolean> {
  if (targetType === "monitor") {
    await assertMonitorHubManaged(db, targetId);
  } else if (targetType === "job") {
    await assertJobHubManaged(db, targetId);
  }
  const { table, pk } = TARGET_TABLE[targetType];
  const statements: SqlStatement[] = [
    {
      sql: "DELETE FROM alert_states WHERE target_type = ?1 AND target_id = ?2",
      params: [targetType, targetId],
    },
  ];
  if (targetType === "node") {
    statements.push(
      {
        sql: "DELETE FROM alert_states WHERE target_type = 'monitor' AND target_id IN (SELECT id FROM monitors WHERE managed_by_node_id = ?1)",
        params: [targetId],
      },
      {
        sql: "DELETE FROM alert_states WHERE target_type = 'job' AND target_id IN (SELECT key FROM jobs WHERE managed_by_node_id = ?1)",
        params: [targetId],
      },
    );
  }
  statements.push({
    sql: `DELETE FROM ${table} WHERE ${pk} = ?1`,
    params: [targetId],
  });
  const results = await db.batch(statements);

  return results.at(-1)!.changes > 0;
}
