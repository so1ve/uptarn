import type { SqlDatabase } from "../db/index.ts";
import type {
  MaintenanceInput,
  MaintenanceSummary,
  MaintenanceTarget,
  PublicMaintenanceSummary,
} from "../shared/index.ts";
import { unixNow } from "../shared/index.ts";
import { parseMaintenanceInput } from "../validation.ts";

export interface MaintenanceRow {
  id: string;
  title: string;
  body: string;
  starts_at: number;
  ends_at: number;
  targets_json: string;
  created_at: number;
}

export const SELECT_ACTIVE_MAINTENANCES_SQL =
  "SELECT id, title, body, starts_at, ends_at, targets_json, created_at FROM maintenances WHERE starts_at <= ?1 AND ends_at > ?1";

export const parseMaintenanceTargets = (raw: string): MaintenanceTarget[] =>
  JSON.parse(raw) as MaintenanceTarget[];

export const maintenanceState = (
  row: Pick<MaintenanceRow, "starts_at" | "ends_at">,
  now: number,
): MaintenanceSummary["state"] =>
  now < row.starts_at ? "upcoming" : now < row.ends_at ? "active" : "completed";

export const toMaintenanceSummary = (
  row: MaintenanceRow,
  now: number,
): MaintenanceSummary => ({
  id: row.id,
  title: row.title,
  body: row.body,
  starts_at: row.starts_at,
  ends_at: row.ends_at,
  targets: parseMaintenanceTargets(row.targets_json),
  state: maintenanceState(row, now),
  created_at: row.created_at,
});

export function maintenanceMuteUntil(
  activeMaintenances: readonly {
    ends_at: number;
    targets: readonly MaintenanceTarget[];
  }[],
  targetType: "node" | "monitor",
  targetId: string,
): number {
  let until = 0;
  for (const m of activeMaintenances) {
    if (
      m.targets.length === 0 ||
      m.targets.some((t) => t.type === targetType && t.id === targetId)
    ) {
      until = Math.max(until, m.ends_at);
    }
  }

  return until;
}

export const parseActiveMaintenances = (
  rows: readonly MaintenanceRow[],
): { ends_at: number; targets: MaintenanceTarget[] }[] =>
  rows.map((row) => ({
    ends_at: row.ends_at,
    targets: parseMaintenanceTargets(row.targets_json),
  }));

export function buildPublicMaintenances(
  rows: readonly MaintenanceRow[],
  now: number,
  publicMonitors: ReadonlyMap<string, { name: string }>,
  publicNodes: ReadonlyMap<string, { label: string }>,
): PublicMaintenanceSummary[] {
  const result: Omit<PublicMaintenanceSummary, "key">[] = [];
  for (const row of rows) {
    if (row.ends_at <= now) {
      continue;
    }
    const rawTargets = parseMaintenanceTargets(row.targets_json);
    let publicNames: string[] = [];
    if (rawTargets.length > 0) {
      publicNames = rawTargets
        .map((t) =>
          t.type === "monitor"
            ? publicMonitors.get(t.id)?.name
            : publicNodes.get(t.id)?.label,
        )
        .filter((name): name is string => Boolean(name));
      if (publicNames.length === 0) {
        continue;
      }
    }
    result.push({
      title: row.title,
      body: row.body,
      starts_at: row.starts_at,
      ends_at: row.ends_at,
      state: now >= row.starts_at ? "active" : "upcoming",
      targets: publicNames,
    });
  }

  result.sort((a, b) => {
    if (a.state !== b.state) {
      return a.state === "active" ? -1 : 1;
    }

    return a.starts_at - b.starts_at;
  });

  return result.map((item, idx) => ({ key: `mt${idx}`, ...item }));
}

export async function upsertMaintenance(
  db: SqlDatabase,
  raw: MaintenanceInput | unknown,
): Promise<string> {
  const parsed = parseMaintenanceInput(raw);
  await db.run(
    `INSERT INTO maintenances (id, title, body, starts_at, ends_at, targets_json, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
     ON CONFLICT(id) DO UPDATE SET
       title = excluded.title,
       body = excluded.body,
       starts_at = excluded.starts_at,
       ends_at = excluded.ends_at,
       targets_json = excluded.targets_json`,
    [
      parsed.id,
      parsed.title,
      parsed.body,
      parsed.starts_at,
      parsed.ends_at,
      JSON.stringify(parsed.targets),
      unixNow(),
    ],
  );

  return parsed.id;
}

export async function deleteMaintenance(
  db: SqlDatabase,
  id: string,
): Promise<boolean> {
  const res = await db.run("DELETE FROM maintenances WHERE id = ?1", [id]);

  return res.changes > 0;
}
