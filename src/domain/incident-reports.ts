import type { SqlDatabase } from "../db/index.ts";
import { httpError } from "../http.ts";
import type {
  IncidentNoteInput,
  IncidentNotePatch,
  IncidentNoteSummary,
  IncidentReportImpact,
  IncidentReportInput,
  IncidentReportStatus,
  IncidentReportSummary,
  IncidentReportUpdate,
  IncidentReportUpdateInput,
  IncidentReportUpdatePatch,
  MaintenanceTarget,
  PublicIncidentReportSummary,
} from "../shared/index.ts";
import { unixNow } from "../shared/index.ts";
import {
  parseIncidentNoteInput,
  parseIncidentNotePatch,
  parseIncidentReportInput,
  parseIncidentReportUpdateInput,
  parseIncidentReportUpdatePatch,
} from "../validation.ts";

export interface IncidentReportRow {
  id: string;
  title: string;
  status: IncidentReportStatus;
  impact: IncidentReportImpact;
  is_public: number;
  targets_json: string;
  updates_json: string;
  created_at: number;
  updated_at: number;
  resolved_at: number | null;
}

export interface IncidentNoteRow {
  id: string;
  incident_key: string;
  status: IncidentReportStatus | null;
  message: string;
  is_public: number;
  created_at: number;
}

const PUBLIC_RESOLVED_WINDOW_SECS = 14 * 86_400;

const newUpdateId = (): string => `upd_${crypto.randomUUID().slice(0, 8)}`;
const newNoteId = (): string => `note_${crypto.randomUUID().slice(0, 8)}`;

export const parseIncidentReportTargets = (raw: string): MaintenanceTarget[] =>
  JSON.parse(raw) as MaintenanceTarget[];

export function parseIncidentReportUpdates(
  raw: string,
): IncidentReportUpdate[] {
  const list = JSON.parse(raw) as Partial<IncidentReportUpdate>[];

  return list.map((u, idx) => ({
    id: u.id ?? `upd_${idx}`,
    status: u.status ?? null,
    message: u.message ?? "",
    created_at: u.created_at ?? 0,
  }));
}

export const toIncidentReportSummary = (
  row: IncidentReportRow,
): IncidentReportSummary => ({
  id: row.id,
  title: row.title,
  status: row.status,
  impact: row.impact,
  is_public: row.is_public === 1,
  targets: parseIncidentReportTargets(row.targets_json),
  updates: parseIncidentReportUpdates(row.updates_json),
  created_at: row.created_at,
  updated_at: row.updated_at,
  resolved_at: row.resolved_at,
});

export const toIncidentNoteSummary = (
  row: IncidentNoteRow,
): IncidentNoteSummary => ({
  id: row.id,
  incident_key: row.incident_key,
  status: row.status ?? null,
  message: row.message,
  is_public: row.is_public === 1,
  created_at: row.created_at,
});

export function buildPublicIncidentReports(
  rows: readonly IncidentReportRow[],
  now: number,
  publicMonitors: ReadonlyMap<string, { name: string }>,
  publicNodes: ReadonlyMap<string, { label: string }>,
): PublicIncidentReportSummary[] {
  const cutoff = now - PUBLIC_RESOLVED_WINDOW_SECS;
  const active: Omit<PublicIncidentReportSummary, "key">[] = [];
  const resolved: Omit<PublicIncidentReportSummary, "key">[] = [];

  for (const row of rows) {
    if (row.is_public !== 1) {
      continue;
    }
    if (row.resolved_at !== null && row.resolved_at < cutoff) {
      continue;
    }
    const rawTargets = parseIncidentReportTargets(row.targets_json);
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
    const item: Omit<PublicIncidentReportSummary, "key"> = {
      title: row.title,
      status: row.status,
      impact: row.impact,
      targets: publicNames,
      updates: parseIncidentReportUpdates(row.updates_json),
      created_at: row.created_at,
      updated_at: row.updated_at,
      resolved_at: row.resolved_at,
    };
    if (row.resolved_at === null && row.status !== "resolved") {
      active.push(item);
    } else {
      resolved.push(item);
    }
  }

  active.sort((a, b) => b.updated_at - a.updated_at);
  resolved.sort(
    (a, b) => (b.resolved_at ?? b.updated_at) - (a.resolved_at ?? a.updated_at),
  );

  return [...active, ...resolved]
    .slice(0, 20)
    .map((item, idx) => ({ key: `ir${idx}`, ...item }));
}

export async function upsertIncidentReport(
  db: SqlDatabase,
  raw: IncidentReportInput | unknown,
): Promise<{ id: string; created: boolean }> {
  const parsed = parseIncidentReportInput(raw);
  const now = unixNow();
  const existing = await db.first<IncidentReportRow>(
    "SELECT * FROM incident_reports WHERE id = ?1",
    [parsed.id],
  );

  if (!existing) {
    const startedAt = parsed.created_at ?? now;
    const updates: IncidentReportUpdate[] = parsed.message
      ? [
          {
            id: newUpdateId(),
            status: parsed.status,
            message: parsed.message,
            created_at: startedAt,
          },
        ]
      : [];
    const resolvedAt = parsed.status === "resolved" ? now : null;
    await db.run(
      `INSERT INTO incident_reports
         (id, title, status, impact, is_public, targets_json, updates_json, created_at, updated_at, resolved_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
      [
        parsed.id,
        parsed.title,
        parsed.status,
        parsed.impact,
        parsed.is_public ? 1 : 0,
        JSON.stringify(parsed.targets),
        JSON.stringify(updates),
        startedAt,
        now,
        resolvedAt,
      ],
    );

    return { id: parsed.id, created: true };
  }

  const updates = parseIncidentReportUpdates(existing.updates_json);
  if (parsed.message) {
    updates.push({
      id: newUpdateId(),
      status: parsed.status,
      message: parsed.message,
      created_at: now,
    });
  }
  const resolvedAt =
    parsed.status === "resolved" ? (existing.resolved_at ?? now) : null;

  await db.run(
    `UPDATE incident_reports
     SET title = ?1, status = ?2, impact = ?3, is_public = ?4, targets_json = ?5,
         updates_json = ?6, created_at = ?7, updated_at = ?8, resolved_at = ?9
     WHERE id = ?10`,
    [
      parsed.title,
      parsed.status,
      parsed.impact,
      parsed.is_public ? 1 : 0,
      JSON.stringify(parsed.targets),
      JSON.stringify(updates),
      parsed.created_at ?? existing.created_at,
      now,
      resolvedAt,
      parsed.id,
    ],
  );

  return { id: parsed.id, created: false };
}

export async function appendIncidentReportUpdate(
  db: SqlDatabase,
  id: string,
  raw: IncidentReportUpdateInput | unknown,
): Promise<IncidentReportSummary> {
  const parsed = parseIncidentReportUpdateInput(raw);
  const existing = await db.first<IncidentReportRow>(
    "SELECT * FROM incident_reports WHERE id = ?1",
    [id],
  );
  if (!existing) {
    throw httpError(404, "Incident report not found");
  }
  const now = unixNow();
  const nextStatus = parsed.status ?? existing.status;
  const updates = parseIncidentReportUpdates(existing.updates_json);
  updates.push({
    id: newUpdateId(),
    status: parsed.status,
    message: parsed.message,
    created_at: parsed.created_at ?? now,
  });
  updates.sort((a, b) => a.created_at - b.created_at);
  const resolvedAt =
    parsed.status === null
      ? existing.resolved_at
      : nextStatus === "resolved"
        ? (existing.resolved_at ?? parsed.created_at ?? now)
        : null;

  await db.run(
    `UPDATE incident_reports
     SET status = ?1, updates_json = ?2, updated_at = ?3, resolved_at = ?4
     WHERE id = ?5`,
    [nextStatus, JSON.stringify(updates), now, resolvedAt, id],
  );

  return toIncidentReportSummary({
    ...existing,
    status: nextStatus,
    updates_json: JSON.stringify(updates),
    updated_at: now,
    resolved_at: resolvedAt,
  });
}

export async function updateIncidentReportEntry(
  db: SqlDatabase,
  reportId: string,
  updateId: string,
  raw: IncidentReportUpdatePatch | unknown,
): Promise<IncidentReportSummary> {
  const patch = parseIncidentReportUpdatePatch(raw);
  const existing = await db.first<IncidentReportRow>(
    "SELECT * FROM incident_reports WHERE id = ?1",
    [reportId],
  );
  if (!existing) {
    throw httpError(404, "Incident report not found");
  }
  const updates = parseIncidentReportUpdates(existing.updates_json);
  const target = updates.find((u) => u.id === updateId);
  if (!target) {
    throw httpError(404, "Timeline update not found");
  }
  if (patch.message !== undefined) {
    target.message = patch.message;
  }
  if (patch.status !== undefined) {
    target.status = patch.status;
  }
  if (patch.created_at !== undefined) {
    target.created_at = patch.created_at;
  }
  updates.sort((a, b) => a.created_at - b.created_at);
  const now = unixNow();

  await db.run(
    "UPDATE incident_reports SET updates_json = ?1, updated_at = ?2 WHERE id = ?3",
    [JSON.stringify(updates), now, reportId],
  );

  return toIncidentReportSummary({
    ...existing,
    updates_json: JSON.stringify(updates),
    updated_at: now,
  });
}

export async function deleteIncidentReportEntry(
  db: SqlDatabase,
  reportId: string,
  updateId: string,
): Promise<IncidentReportSummary> {
  const existing = await db.first<IncidentReportRow>(
    "SELECT * FROM incident_reports WHERE id = ?1",
    [reportId],
  );
  if (!existing) {
    throw httpError(404, "Incident report not found");
  }
  const updates = parseIncidentReportUpdates(existing.updates_json);
  const next = updates.filter((u) => u.id !== updateId);
  if (next.length === updates.length) {
    throw httpError(404, "Timeline update not found");
  }
  const now = unixNow();

  await db.run(
    "UPDATE incident_reports SET updates_json = ?1, updated_at = ?2 WHERE id = ?3",
    [JSON.stringify(next), now, reportId],
  );

  return toIncidentReportSummary({
    ...existing,
    updates_json: JSON.stringify(next),
    updated_at: now,
  });
}

export async function deleteIncidentReport(
  db: SqlDatabase,
  id: string,
): Promise<boolean> {
  const res = await db.run("DELETE FROM incident_reports WHERE id = ?1", [id]);

  return res.changes > 0;
}

export async function createIncidentNote(
  db: SqlDatabase,
  raw: IncidentNoteInput | unknown,
): Promise<IncidentNoteSummary> {
  const parsed = parseIncidentNoteInput(raw);
  const id = newNoteId();
  const createdAt = parsed.created_at ?? unixNow();

  await db.run(
    `INSERT INTO incident_notes (id, incident_key, status, message, is_public, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    [
      id,
      parsed.incident_key,
      parsed.status,
      parsed.message,
      parsed.is_public ? 1 : 0,
      createdAt,
    ],
  );

  return {
    id,
    incident_key: parsed.incident_key,
    status: parsed.status,
    message: parsed.message,
    is_public: parsed.is_public,
    created_at: createdAt,
  };
}

export async function updateIncidentNote(
  db: SqlDatabase,
  id: string,
  raw: IncidentNotePatch | unknown,
): Promise<IncidentNoteSummary | null> {
  const patch = parseIncidentNotePatch(raw);
  const existing = await db.first<IncidentNoteRow>(
    "SELECT * FROM incident_notes WHERE id = ?1",
    [id],
  );
  if (!existing) {
    return null;
  }
  const next: IncidentNoteRow = {
    ...existing,
    status: patch.status === undefined ? existing.status : patch.status,
    message: patch.message ?? existing.message,
    is_public:
      patch.is_public === undefined
        ? existing.is_public
        : patch.is_public
          ? 1
          : 0,
    created_at: patch.created_at ?? existing.created_at,
  };

  await db.run(
    `UPDATE incident_notes
     SET status = ?1, message = ?2, is_public = ?3, created_at = ?4
     WHERE id = ?5`,
    [next.status, next.message, next.is_public, next.created_at, id],
  );

  return toIncidentNoteSummary(next);
}

export async function deleteIncidentNote(
  db: SqlDatabase,
  id: string,
): Promise<boolean> {
  const res = await db.run("DELETE FROM incident_notes WHERE id = ?1", [id]);

  return res.changes > 0;
}
