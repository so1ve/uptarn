import { generateRandomToken } from "../auth/index.ts";
import type { LoadedConfig } from "../config.ts";
import type { SqlDatabase, SqlStatement } from "../db/index.ts";
import { httpError } from "../http.ts";
import type { TargetType } from "../shared/index.ts";
import { unixNow } from "../shared/index.ts";

export interface RuntimeSettings {
  autoRegister: boolean;
  enrollmentToken: string | null;
  globalMutedUntil: number;
  lastPruneAt: number;
}

export interface SettingRow {
  key: string;
  value: string;
}

export const SELECT_SETTINGS_SQL = "SELECT key, value FROM system_settings";

export function parseRuntimeSettings(
  rows: readonly SettingRow[],
  config: LoadedConfig,
): RuntimeSettings {
  const map = new Map(rows.map((r) => [r.key, r.value]));
  const autoRaw = map.get("auto_register");

  return {
    autoRegister:
      autoRaw === undefined ? config.defaultAutoRegister : autoRaw === "1",
    enrollmentToken:
      map.get("enrollment_token") || config.enrollmentToken || null,
    globalMutedUntil: Number.parseInt(map.get("global_muted_until") ?? "0", 10),
    lastPruneAt: Number.parseInt(map.get("last_prune_at") ?? "0", 10),
  };
}

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

export async function updateRuntimeSettings(
  db: SqlDatabase,
  config: LoadedConfig,
  patch: {
    auto_register?: boolean;
    rotate_enrollment_token?: boolean;
    global_muted_until?: number;
  },
): Promise<RuntimeSettings> {
  const now = unixNow();
  const next = parseRuntimeSettings(
    await db.all<SettingRow>(SELECT_SETTINGS_SQL),
    config,
  );
  const statements: SqlStatement[] = [];

  if (patch.auto_register !== undefined) {
    next.autoRegister = patch.auto_register;
    statements.push(
      upsertSettingStmt("auto_register", patch.auto_register ? "1" : "0", now),
    );
  }

  if (
    patch.rotate_enrollment_token ||
    (patch.auto_register && !next.enrollmentToken)
  ) {
    next.enrollmentToken = generateRandomToken("uptn_enroll");
    statements.push(
      upsertSettingStmt("enrollment_token", next.enrollmentToken, now),
    );
  }

  if (patch.global_muted_until !== undefined) {
    next.globalMutedUntil = Math.max(0, Math.floor(patch.global_muted_until));
    statements.push(
      upsertSettingStmt(
        "global_muted_until",
        String(next.globalMutedUntil),
        now,
      ),
    );
  }

  await db.batch(statements);

  return next;
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
    const existing = await db.first<{ managed_by_node_id: string | null }>(
      "SELECT managed_by_node_id FROM monitors WHERE id = ?1",
      [targetId],
    );
    if (existing?.managed_by_node_id) {
      throw httpError(
        409,
        `Monitor "${targetId}" is managed by node "${existing.managed_by_node_id}"`,
      );
    }
  }
  const { table, pk } = TARGET_TABLE[targetType];
  const statements: SqlStatement[] = [
    {
      sql: "DELETE FROM alert_states WHERE target_type = ?1 AND target_id = ?2",
      params: [targetType, targetId],
    },
  ];
  if (targetType === "node") {
    statements.push({
      sql: "DELETE FROM alert_states WHERE target_type = 'monitor' AND target_id IN (SELECT id FROM monitors WHERE managed_by_node_id = ?1)",
      params: [targetId],
    });
  }
  statements.push({
    sql: `DELETE FROM ${table} WHERE ${pk} = ?1`,
    params: [targetId],
  });
  const results = await db.batch(statements);

  return results.at(-1)!.changes > 0;
}
