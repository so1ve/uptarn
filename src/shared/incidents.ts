import type { AlertEventSummary, TargetType } from "./protocol.ts";

export interface IncidentHistoryRecord {
  id: number;
  incident_key: string;
  target_type: TargetType;
  target_id: string;
  label: string;
  state: "resolved" | "unpaired";
  started_at: number;
  resolved_at: number | null;
  duration_secs: number | null;
  summary: string;
  resolved_summary: string | null;
  firing_delivery: Record<string, string>;
  resolved_delivery: Record<string, string> | null;
}

/**
 * Pair chronological firing/resolved alert events into single incident runs,
 * newest first. Ongoing incidents that are currently active (in activeKeys) are
 * omitted so they are not duplicated below the Active Incidents list.
 */
export function pairIncidentEvents(
  events: readonly AlertEventSummary[],
  activeKeys: ReadonlySet<string> = new Set(),
): IncidentHistoryRecord[] {
  const pending = new Map<string, AlertEventSummary>();
  const records: IncidentHistoryRecord[] = [];

  for (const ev of [...events].reverse()) {
    if (ev.kind === "firing") {
      const existing = pending.get(ev.incident_key);
      if (existing) {
        // Keep earliest start time, update delivery/summary if a later notification fired after unmute.
        pending.set(ev.incident_key, {
          ...ev,
          created_at: existing.created_at,
        });
      } else {
        pending.set(ev.incident_key, ev);
      }

      continue;
    }

    const started = pending.get(ev.incident_key);
    pending.delete(ev.incident_key);
    const startedAt = started?.created_at ?? ev.created_at;
    records.push({
      id: ev.id,
      incident_key: ev.incident_key,
      target_type: ev.target_type,
      target_id: ev.target_id,
      label: started?.label ?? ev.label,
      state: "resolved",
      started_at: startedAt,
      resolved_at: ev.created_at,
      duration_secs: started ? Math.max(0, ev.created_at - startedAt) : null,
      summary: started?.summary ?? ev.summary,
      resolved_summary: started ? ev.summary : null,
      firing_delivery: started?.delivery ?? ev.delivery,
      resolved_delivery: started ? ev.delivery : null,
    });
  }

  for (const ev of pending.values()) {
    if (activeKeys.has(ev.incident_key)) {
      continue;
    }
    records.push({
      id: ev.id,
      incident_key: ev.incident_key,
      target_type: ev.target_type,
      target_id: ev.target_id,
      label: ev.label,
      state: "unpaired",
      started_at: ev.created_at,
      resolved_at: null,
      duration_secs: null,
      summary: ev.summary,
      resolved_summary: null,
      firing_delivery: ev.delivery,
      resolved_delivery: null,
    });
  }

  records.sort(
    (a, b) =>
      (b.resolved_at ?? b.started_at) - (a.resolved_at ?? a.started_at) ||
      b.id - a.id,
  );

  return records;
}
