<script setup lang="ts">
import { computed, ref } from "vue";

import IncidentTimeline from "../components/incidents/IncidentTimeline.vue";
import IncidentReportModal from "../components/modals/IncidentReportModal.vue";
import ConfirmPopover from "../components/ui/ConfirmPopover.vue";
import EmptyState from "../components/ui/EmptyState.vue";
import MuteButton from "../components/ui/MuteButton.vue";
import MutedBadge from "../components/ui/MutedBadge.vue";
import PageHeader from "../components/ui/PageHeader.vue";
import SegmentedControl from "../components/ui/SegmentedControl.vue";
import StatusDot from "../components/ui/StatusDot.vue";
import type {
  IncidentHistoryRecord,
  IncidentNoteSummary,
  IncidentReportStatus,
  IncidentReportSummary,
  IncidentSummary,
  MaintenanceTarget,
  TargetType,
  TimelineEntry,
} from "../lib/index.ts";
import {
  INCIDENT_REPORT_STATUS_LABEL,
  activeAutoIncidentTimeline,
  apiFetch,
  deliveryStatus,
  formatAge,
  formatDuration,
  formatTimestamp,
  historyRecordTimeline,
  incidentReportBadgeColor,
  incidentReportDotStatus,
  incidentReportTimeline,
  incidentRoute,
  incidentTargetPath,
  pairIncidentEvents,
  splitAlertLabel,
  splitIncident,
  targetMutedUntil,
  useAction,
  usePageTitle,
  useSnapshot,
} from "../lib/index.ts";

usePageTitle("Incidents");

const snap = useSnapshot();
const { busy, run } = useAction();

type HistoryFilter = "all" | "manual" | TargetType;

const FILTER_OPTIONS: readonly { value: HistoryFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "manual", label: "Manual" },
  { value: "node", label: "Nodes" },
  { value: "monitor", label: "Monitors" },
  { value: "job", label: "Jobs" },
];

const historyFilter = ref<HistoryFilter>("all");
const historyQuery = ref("");

const reportModalOpen = ref(false);
const editingReport = ref<IncidentReportSummary | null>(null);
const toggledItems = ref(new Set<string>());

function isExpanded(itemKey: string, defaultOpen: boolean): boolean {
  const toggled = toggledItems.value.has(itemKey);

  return toggled ? !defaultOpen : defaultOpen;
}

function toggleItem(itemKey: string) {
  const next = new Set(toggledItems.value);
  if (next.has(itemKey)) {
    next.delete(itemKey);
  } else {
    next.add(itemKey);
  }
  toggledItems.value = next;
}

function targetLabel(t: MaintenanceTarget): string {
  if (t.type === "monitor") {
    return snap.value.monitors.find((m) => m.id === t.id)?.name ?? t.id;
  }

  return snap.value.nodes.find((n) => n.id === t.id)?.label ?? t.id;
}

function targetEntityName(type: TargetType, id: string): string {
  if (type === "node") {
    return snap.value.nodes.find((n) => n.id === id)?.label ?? id;
  }
  if (type === "monitor") {
    return snap.value.monitors.find((m) => m.id === id)?.name ?? id;
  }

  return snap.value.jobs.find((j) => j.key === id)?.label ?? id;
}

const notesByIncidentKey = computed(() => {
  const map = new Map<string, IncidentNoteSummary[]>();
  for (const n of snap.value.incident_notes ?? []) {
    const list = map.get(n.incident_key);
    if (list) {
      list.push(n);
    } else {
      map.set(n.incident_key, [n]);
    }
  }

  return map;
});

const matchNotesForAutoRun = (
  incidentKey: string,
  startedAt: number,
  nextStartedAt: number,
): IncidentNoteSummary[] =>
  (notesByIncidentKey.value.get(incidentKey) ?? []).filter(
    (n) => n.created_at >= startedAt && n.created_at < nextStartedAt,
  );

type UnifiedActiveItem =
  | {
      itemKey: string;
      source: "manual";
      sortAt: number;
      report: IncidentReportSummary;
      timeline: TimelineEntry[];
    }
  | {
      itemKey: string;
      source: "auto";
      sortAt: number;
      inc: IncidentSummary;
      kind: string;
      title: string;
      targetName: string;
      to: string;
      mutedUntil: number;
      timeline: TimelineEntry[];
    };

type UnifiedHistoryItem =
  | {
      itemKey: string;
      source: "manual";
      filterKind: "manual";
      sortAt: number;
      searchText: string;
      report: IncidentReportSummary;
      timeline: TimelineEntry[];
    }
  | {
      itemKey: string;
      source: "auto";
      filterKind: TargetType;
      sortAt: number;
      searchText: string;
      rec: IncidentHistoryRecord;
      kind: string;
      title: string;
      targetName: string;
      to: string;
      delivery: ReturnType<typeof deliveryStatus>;
      noteIds: string[];
      timeline: TimelineEntry[];
    };

// Pre-compute run boundaries per incident_key so notes attach to the right run.
const activeAutoStartByKey = computed(
  () =>
    new Map(
      snap.value.incidents.map((i) => [
        i.incident_key,
        i.opened_at ?? i.last_changed_at,
      ]),
    ),
);

const activeItems = computed<UnifiedActiveItem[]>(() => {
  const items: UnifiedActiveItem[] = [];

  for (const rep of snap.value.incident_reports ?? []) {
    if (rep.resolved_at !== null || rep.status === "resolved") {
      continue;
    }
    items.push({
      itemKey: `rep:${rep.id}`,
      source: "manual",
      sortAt: rep.updated_at,
      report: rep,
      timeline: incidentReportTimeline(rep.updates, rep.impact, true),
    });
  }

  for (const inc of snap.value.incidents) {
    const startedAt = inc.opened_at ?? inc.last_changed_at;
    const notes = matchNotesForAutoRun(inc.incident_key, startedAt, Infinity);
    const { kind, title } = splitIncident(inc);
    items.push({
      itemKey: `auto:${inc.incident_key}`,
      source: "auto",
      sortAt: inc.last_changed_at,
      inc,
      kind,
      title,
      targetName: targetEntityName(inc.target_type, inc.target_id),
      to: incidentRoute(inc),
      mutedUntil: targetMutedUntil(snap.value, inc.target_type, inc.target_id),
      timeline: activeAutoIncidentTimeline(inc, notes),
    });
  }

  items.sort((a, b) => b.sortAt - a.sortAt);

  return items;
});

const allHistoryItems = computed<UnifiedHistoryItem[]>(() => {
  const items: UnifiedHistoryItem[] = [];

  for (const rep of snap.value.incident_reports ?? []) {
    if (rep.resolved_at === null && rep.status !== "resolved") {
      continue;
    }
    const targetText = rep.targets.map(targetLabel).join(" ");
    const updatesText = rep.updates.map((u) => u.message).join(" ");
    items.push({
      itemKey: `rep:${rep.id}`,
      source: "manual",
      filterKind: "manual",
      sortAt: rep.resolved_at ?? rep.updated_at,
      searchText: `${rep.title} ${targetText} ${updatesText}`.toLowerCase(),
      report: rep,
      timeline: incidentReportTimeline(rep.updates, rep.impact, true),
    });
  }

  const activeKeys = new Set(snap.value.incidents.map((i) => i.incident_key));
  const paired = pairIncidentEvents(snap.value.events, activeKeys);
  const runsByKey = new Map<string, IncidentHistoryRecord[]>();
  for (const rec of paired) {
    const list = runsByKey.get(rec.incident_key);
    if (list) {
      list.push(rec);
    } else {
      runsByKey.set(rec.incident_key, [rec]);
    }
  }
  const nextStartByRecordId = new Map<number, number>();
  for (const [key, list] of runsByKey) {
    const asc = [...list].sort((a, b) => a.started_at - b.started_at);
    const activeStart = activeAutoStartByKey.value.get(key) ?? Infinity;
    for (let i = 0; i < asc.length; i += 1) {
      nextStartByRecordId.set(asc[i].id, asc[i + 1]?.started_at ?? activeStart);
    }
  }

  for (const rec of paired) {
    const { kind, subject } = splitAlertLabel(rec.target_type, rec.label);
    const title = rec.target_type === "node" ? rec.label : subject;
    const notes = matchNotesForAutoRun(
      rec.incident_key,
      rec.started_at,
      nextStartByRecordId.get(rec.id) ?? Infinity,
    );
    const notesText = notes.map((n) => n.message).join(" ");
    items.push({
      itemKey: `hist:${rec.incident_key}:${rec.id}`,
      source: "auto",
      filterKind: rec.target_type,
      sortAt: rec.resolved_at ?? rec.started_at,
      searchText:
        `${title} ${rec.label} ${rec.summary} ${rec.target_id} ${notesText}`.toLowerCase(),
      rec,
      kind,
      title,
      targetName: targetEntityName(rec.target_type, rec.target_id),
      to: incidentTargetPath(rec.target_type, rec.target_id),
      delivery: deliveryStatus(rec.firing_delivery, rec.resolved_delivery),
      noteIds: notes.map((n) => n.id),
      timeline: historyRecordTimeline(rec, notes),
    });
  }

  items.sort((a, b) => b.sortAt - a.sortAt);

  return items;
});

const filteredHistoryItems = computed(() => {
  const query = historyQuery.value.trim().toLowerCase();

  return allHistoryItems.value.filter((item) => {
    if (
      historyFilter.value !== "all" &&
      item.filterKind !== historyFilter.value
    ) {
      return false;
    }

    return !query || item.searchText.includes(query);
  });
});

function openReportModal(rep: IncidentReportSummary | null) {
  editingReport.value = rep;
  reportModalOpen.value = true;
}

// ── Manual report timeline actions ──
const onAddReportUpdate = (
  rep: IncidentReportSummary,
  payload: { message: string; status: IncidentReportStatus | null },
) =>
  run(
    `rep:${rep.id}:add`,
    "Could not post update",
    async () => {
      await apiFetch(
        `/api/v1/admin/incident-reports/${encodeURIComponent(rep.id)}/updates`,
        "POST",
        { message: payload.message, status: payload.status },
      );

      return payload.status === "resolved"
        ? "Incident resolved"
        : "Update posted";
    },
    true,
  );

const onEditReportUpdate = (
  rep: IncidentReportSummary,
  payload: {
    id: string;
    message: string;
    status: IncidentReportStatus | null;
    createdAt: number;
  },
) =>
  run(
    `rep:${rep.id}:edit:${payload.id}`,
    "Could not edit update",
    async () => {
      await apiFetch(
        `/api/v1/admin/incident-reports/${encodeURIComponent(rep.id)}/updates/${encodeURIComponent(payload.id)}`,
        "PATCH",
        {
          message: payload.message,
          status: payload.status,
          created_at: payload.createdAt,
        },
      );

      return "Update saved";
    },
    true,
  );

const onDeleteReportUpdate = (rep: IncidentReportSummary, updateId: string) =>
  run(
    `rep:${rep.id}:del:${updateId}`,
    "Could not delete update",
    async () => {
      await apiFetch(
        `/api/v1/admin/incident-reports/${encodeURIComponent(rep.id)}/updates/${encodeURIComponent(updateId)}`,
        "DELETE",
      );

      return "Update deleted";
    },
    true,
  );

function onToggleReportResolved(rep: IncidentReportSummary) {
  const resolve = rep.resolved_at === null && rep.status !== "resolved";

  return run(
    `rep:${rep.id}:toggle`,
    "Could not update status",
    async () => {
      await apiFetch("/api/v1/admin/incident-reports", "POST", {
        id: rep.id,
        title: rep.title,
        status: resolve ? "resolved" : "investigating",
        impact: rep.impact,
        is_public: rep.is_public,
        targets: rep.targets,
      });

      return resolve ? "Marked resolved" : "Incident reopened";
    },
    true,
  );
}

// ── Auto-detected incident timeline notes & controls ──
const onAddAutoNote = (
  incidentKey: string,
  payload: {
    message: string;
    status: IncidentReportStatus | null;
    isPublic: boolean;
  },
) =>
  run(
    `auto:${incidentKey}:add`,
    "Could not post update",
    async () => {
      await apiFetch("/api/v1/admin/incident-notes", "POST", {
        incident_key: incidentKey,
        message: payload.message,
        status: payload.status,
        is_public: payload.isPublic,
      });

      return "Update posted";
    },
    true,
  );

const onEditAutoNote = (
  incidentKey: string,
  payload: {
    id: string;
    message: string;
    status: IncidentReportStatus | null;
    createdAt: number;
    isPublic?: boolean;
  },
) =>
  run(
    `auto:${incidentKey}:edit:${payload.id}`,
    "Could not edit update",
    async () => {
      await apiFetch(
        `/api/v1/admin/incident-notes/${encodeURIComponent(payload.id)}`,
        "PATCH",
        {
          message: payload.message,
          status: payload.status,
          created_at: payload.createdAt,
          ...(payload.isPublic === undefined
            ? {}
            : { is_public: payload.isPublic }),
        },
      );

      return "Update saved";
    },
    true,
  );

const onDeleteAutoNote = (incidentKey: string, noteId: string) =>
  run(
    `auto:${incidentKey}:del:${noteId}`,
    "Could not delete update",
    async () => {
      await apiFetch(
        `/api/v1/admin/incident-notes/${encodeURIComponent(noteId)}`,
        "DELETE",
      );

      return "Update deleted";
    },
    true,
  );

function onToggleBanner(inc: IncidentSummary) {
  const hide = inc.acknowledged_at === null;

  return run(
    `ack:${inc.incident_key}`,
    "Could not update incident",
    async () => {
      await apiFetch("/api/v1/admin/incidents/ack", "POST", {
        incident_key: inc.incident_key,
        acknowledged: hide,
      });

      return hide ? "Hidden from top banner" : "Restored to top banner";
    },
    true,
  );
}

const onDismissActive = (inc: IncidentSummary) =>
  run(
    `dismiss:${inc.incident_key}`,
    "Could not dismiss incident",
    async () => {
      await apiFetch("/api/v1/admin/incidents/dismiss", "POST", {
        incident_key: inc.incident_key,
      });

      return "Incident dismissed";
    },
    true,
  );

const onDeleteHistory = (rec: IncidentHistoryRecord, noteIds: string[]) =>
  run(
    `delhist:${rec.id}`,
    "Could not delete incident",
    async () => {
      await apiFetch("/api/v1/admin/incidents/history/delete", "POST", {
        event_ids: rec.event_ids,
        note_ids: noteIds,
      });

      return "Incident deleted from history";
    },
    true,
  );

function timelineBusyKey(prefix: string): string | null {
  if (!busy.value?.startsWith(`${prefix}:`)) {
    return null;
  }

  return busy.value.slice(prefix.length + 1);
}
</script>

<template>
  <div class="space-y-8">
    <PageHeader title="Incidents">
      <UButton
        color="primary"
        icon="i-lucide-plus"
        size="xs"
        @click="openReportModal(null)"
      >
        New incident
      </UButton>
    </PageHeader>

    <section aria-labelledby="active-heading" class="space-y-3">
      <div class="flex items-baseline gap-2">
        <h2 id="active-heading" class="text-sm font-semibold">Active</h2>
        <span class="text-xs text-dimmed tabular-nums">
          {{ activeItems.length }}
        </span>
      </div>

      <EmptyState v-if="activeItems.length === 0">
        No active incidents.
      </EmptyState>

      <div v-else class="space-y-3">
        <article
          v-for="item in activeItems"
          :key="item.itemKey"
          class="rounded-xl border border-default bg-surface"
        >
          <!-- Manual active incident -->
          <template v-if="item.source === 'manual'">
            <button
              :aria-expanded="isExpanded(item.itemKey, true)"
              class="flex w-full cursor-pointer flex-wrap items-center justify-between gap-3 px-4 py-3.5 text-left focus-visible:outline-2 focus-visible:outline-primary"
              type="button"
              @click="toggleItem(item.itemKey)"
            >
              <div class="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                <UIcon
                  class="size-3.5 shrink-0 text-dimmed transition-transform duration-150"
                  :class="isExpanded(item.itemKey, true) ? 'rotate-180' : ''"
                  name="i-lucide-chevron-down"
                />
                <StatusDot
                  :status="
                    incidentReportDotStatus(
                      item.report.status,
                      item.report.impact,
                    )
                  "
                />
                <span class="text-sm font-semibold">
                  {{ item.report.title }}
                </span>
                <UBadge
                  :color="
                    incidentReportBadgeColor(
                      item.report.status,
                      item.report.impact,
                    )
                  "
                  size="xs"
                  variant="subtle"
                >
                  {{ INCIDENT_REPORT_STATUS_LABEL[item.report.status] }}
                </UBadge>
                <UBadge
                  v-if="!item.report.is_public"
                  color="neutral"
                  size="xs"
                  variant="subtle"
                >
                  Private
                </UBadge>
                <UBadge
                  v-for="t in item.report.targets"
                  :key="`${t.type}:${t.id}`"
                  color="neutral"
                  size="xs"
                  variant="subtle"
                >
                  {{ targetLabel(t) }}
                </UBadge>
              </div>

              <div
                class="flex shrink-0 items-center gap-3 font-mono text-xs text-dimmed tabular-nums"
              >
                <span>
                  {{
                    formatDuration(
                      Math.max(0, snap.now - item.report.created_at),
                    )
                  }}
                </span>
                <UTooltip :text="formatTimestamp(item.report.created_at, true)">
                  <span>{{ formatAge(item.report.created_at, snap.now) }}</span>
                </UTooltip>
              </div>
            </button>

            <div
              v-if="isExpanded(item.itemKey, true)"
              class="space-y-4 border-t border-default px-4 py-3.5"
            >
              <IncidentTimeline
                allow-resolve-status
                :busy-key="timelineBusyKey(`rep:${item.report.id}`)"
                can-add
                :entries="item.timeline"
                :now="snap.now"
                @add="(p) => onAddReportUpdate(item.report, p)"
                @delete="(id) => onDeleteReportUpdate(item.report, id)"
                @edit="(p) => onEditReportUpdate(item.report, p)"
              />

              <div
                class="flex flex-wrap items-center justify-end gap-2 border-t border-default/60 pt-3"
              >
                <UButton
                  color="neutral"
                  icon="i-lucide-pencil"
                  size="xs"
                  variant="ghost"
                  @click="openReportModal(item.report)"
                >
                  Edit details
                </UButton>
                <UButton
                  color="neutral"
                  icon="i-lucide-check-circle-2"
                  :loading="busy === `rep:${item.report.id}:toggle`"
                  size="xs"
                  variant="soft"
                  @click="onToggleReportResolved(item.report)"
                >
                  Mark resolved
                </UButton>
              </div>
            </div>
          </template>

          <!-- Auto-detected active incident -->
          <template v-else>
            <button
              :aria-expanded="isExpanded(item.itemKey, true)"
              class="flex w-full cursor-pointer flex-wrap items-center justify-between gap-3 px-4 py-3.5 text-left focus-visible:outline-2 focus-visible:outline-primary"
              type="button"
              @click="toggleItem(item.itemKey)"
            >
              <div class="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                <UIcon
                  class="size-3.5 shrink-0 text-dimmed transition-transform duration-150"
                  :class="isExpanded(item.itemKey, true) ? 'rotate-180' : ''"
                  name="i-lucide-chevron-down"
                />
                <StatusDot
                  :status="item.inc.state === 'open' ? 'fail' : 'warn'"
                />
                <UBadge color="neutral" size="xs" variant="subtle">
                  {{ item.kind }}
                </UBadge>
                <span class="text-sm font-semibold">{{ item.title }}</span>
                <UBadge
                  v-if="item.inc.acknowledged_at !== null"
                  color="neutral"
                  size="xs"
                  variant="subtle"
                >
                  Banner hidden
                </UBadge>
                <MutedBadge :now="snap.now" :until="item.mutedUntil" />
                <span class="truncate font-mono text-xs text-muted">
                  {{ item.inc.last_summary }}
                </span>
              </div>

              <div
                class="flex shrink-0 items-center gap-3 font-mono text-xs text-dimmed tabular-nums"
              >
                <span>
                  {{
                    item.inc.opened_at === null
                      ? `${item.inc.consecutive_failures} ${item.inc.consecutive_failures === 1 ? "failure" : "failures"}`
                      : formatDuration(snap.now - item.inc.opened_at)
                  }}
                </span>
              </div>
            </button>

            <div
              v-if="isExpanded(item.itemKey, true)"
              class="space-y-4 border-t border-default px-4 py-3.5"
            >
              <IncidentTimeline
                :busy-key="timelineBusyKey(`auto:${item.inc.incident_key}`)"
                can-add
                :entries="item.timeline"
                :now="snap.now"
                show-public-toggle
                @add="(p) => onAddAutoNote(item.inc.incident_key, p)"
                @delete="(id) => onDeleteAutoNote(item.inc.incident_key, id)"
                @edit="(p) => onEditAutoNote(item.inc.incident_key, p)"
              />

              <div
                class="flex flex-wrap items-center justify-between gap-2 border-t border-default/60 pt-3"
              >
                <RouterLink
                  class="inline-flex items-center gap-1 text-xs font-medium text-muted transition-colors hover:text-primary"
                  :to="item.to"
                >
                  <span>Open {{ item.targetName }}</span>
                  <UIcon class="size-3.5" name="i-lucide-arrow-up-right" />
                </RouterLink>

                <div class="flex flex-wrap items-center gap-2">
                  <UButton
                    color="neutral"
                    :icon="
                      item.inc.acknowledged_at === null
                        ? 'i-lucide-eye-off'
                        : 'i-lucide-eye'
                    "
                    :loading="busy === `ack:${item.inc.incident_key}`"
                    size="xs"
                    variant="ghost"
                    @click="onToggleBanner(item.inc)"
                  >
                    {{
                      item.inc.acknowledged_at === null
                        ? "Hide from banner"
                        : "Show in banner"
                    }}
                  </UButton>

                  <MuteButton
                    :idle-label="`Mute ${item.kind.toLowerCase()}`"
                    :label="item.targetName"
                    :muted-until="item.mutedUntil"
                    :now="snap.now"
                    :scope-note="`Silences all alert notifications for ${item.targetName}.`"
                    :target-id="item.inc.target_id"
                    :target-type="item.inc.target_type"
                  />
                  <ConfirmPopover
                    color="error"
                    confirm-label="Dismiss"
                    label="Dismiss"
                    :loading="busy === `dismiss:${item.inc.incident_key}`"
                    @confirm="onDismissActive(item.inc)"
                  >
                    Dismiss this active incident? If the target is still
                    failing, it will reappear on the next check.
                  </ConfirmPopover>
                </div>
              </div>
            </div>
          </template>
        </article>
      </div>
    </section>

    <section aria-labelledby="history-heading" class="space-y-3">
      <div class="flex flex-wrap items-center justify-between gap-2.5">
        <div class="flex items-baseline gap-2">
          <h2 id="history-heading" class="text-sm font-semibold">History</h2>
          <span class="text-xs text-dimmed tabular-nums">
            {{ filteredHistoryItems.length }}
          </span>
        </div>

        <div
          v-if="allHistoryItems.length > 0"
          class="flex flex-wrap items-center gap-2"
        >
          <SegmentedControl
            v-model="historyFilter"
            aria-label="Filter incident history by type"
            :options="FILTER_OPTIONS"
          />
          <UInput
            v-model="historyQuery"
            aria-label="Search incident history"
            class="w-44 sm:w-52"
            icon="i-lucide-search"
            placeholder="Filter history"
            size="xs"
          />
        </div>
      </div>

      <EmptyState v-if="allHistoryItems.length === 0">
        No incident history yet.
      </EmptyState>

      <EmptyState v-else-if="filteredHistoryItems.length === 0">
        No matching incidents.
      </EmptyState>

      <ol v-else class="divide-y divide-default border-y border-default">
        <li
          v-for="item in filteredHistoryItems"
          :key="item.itemKey"
          class="py-3.5"
        >
          <!-- Resolved manual incident -->
          <template v-if="item.source === 'manual'">
            <div class="flex items-start gap-2">
              <button
                :aria-expanded="isExpanded(item.itemKey, false)"
                :aria-label="`Toggle timeline for ${item.report.title}`"
                class="mt-0.5 inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded text-dimmed transition-colors hover:bg-elevated hover:text-default focus-visible:outline-2 focus-visible:outline-primary"
                type="button"
                @click="toggleItem(item.itemKey)"
              >
                <UIcon
                  class="size-3.5 transition-transform duration-150"
                  :class="isExpanded(item.itemKey, false) ? 'rotate-180' : ''"
                  name="i-lucide-chevron-down"
                />
              </button>
              <StatusDot class="mt-1.5" status="ok" />
              <div class="min-w-0 flex-1 space-y-1">
                <button
                  :aria-expanded="isExpanded(item.itemKey, false)"
                  class="flex w-full cursor-pointer flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-left text-sm focus-visible:outline-2 focus-visible:outline-primary"
                  type="button"
                  @click="toggleItem(item.itemKey)"
                >
                  <div class="flex min-w-0 flex-wrap items-center gap-2">
                    <UBadge color="neutral" size="xs" variant="subtle">
                      Manual
                    </UBadge>
                    <span class="font-medium">{{ item.report.title }}</span>
                    <UBadge
                      v-if="!item.report.is_public"
                      color="neutral"
                      size="xs"
                      variant="subtle"
                    >
                      Private
                    </UBadge>
                    <UBadge
                      v-for="t in item.report.targets"
                      :key="`${t.type}:${t.id}`"
                      color="neutral"
                      size="xs"
                      variant="subtle"
                    >
                      {{ targetLabel(t) }}
                    </UBadge>
                  </div>

                  <div
                    class="flex shrink-0 items-center gap-3 font-mono text-xs text-dimmed tabular-nums"
                  >
                    <span
                      v-if="item.report.updates.length > 0"
                      class="hidden sm:inline"
                    >
                      {{ item.report.updates.length }}
                      {{
                        item.report.updates.length === 1 ? "update" : "updates"
                      }}
                    </span>
                    <span>
                      {{
                        formatDuration(
                          Math.max(
                            0,
                            (item.report.resolved_at ??
                              item.report.updated_at) - item.report.created_at,
                          ),
                        )
                      }}
                    </span>
                    <UTooltip
                      :text="formatTimestamp(item.report.created_at, true)"
                    >
                      <span>
                        {{ formatAge(item.report.created_at, snap.now) }}
                      </span>
                    </UTooltip>
                  </div>
                </button>

                <button
                  v-if="item.timeline[0]?.message"
                  :aria-expanded="isExpanded(item.itemKey, false)"
                  class="block w-full cursor-pointer truncate text-left font-mono text-xs text-muted"
                  type="button"
                  @click="toggleItem(item.itemKey)"
                >
                  {{ item.timeline[0].message }}
                </button>

                <div
                  v-if="isExpanded(item.itemKey, false)"
                  class="space-y-3 pt-3"
                >
                  <IncidentTimeline
                    allow-resolve-status
                    :busy-key="timelineBusyKey(`rep:${item.report.id}`)"
                    can-add
                    :entries="item.timeline"
                    :now="snap.now"
                    @add="(p) => onAddReportUpdate(item.report, p)"
                    @delete="(id) => onDeleteReportUpdate(item.report, id)"
                    @edit="(p) => onEditReportUpdate(item.report, p)"
                  />

                  <div class="flex items-center justify-end gap-2 pt-1">
                    <UButton
                      color="neutral"
                      icon="i-lucide-pencil"
                      size="xs"
                      variant="ghost"
                      @click="openReportModal(item.report)"
                    >
                      Edit details
                    </UButton>
                    <UButton
                      color="neutral"
                      icon="i-lucide-rotate-ccw"
                      :loading="busy === `rep:${item.report.id}:toggle`"
                      size="xs"
                      variant="ghost"
                      @click="onToggleReportResolved(item.report)"
                    >
                      Reopen
                    </UButton>
                  </div>
                </div>
              </div>
            </div>
          </template>

          <!-- Resolved auto-detected incident -->
          <template v-else>
            <div class="flex items-start gap-2">
              <button
                :aria-expanded="isExpanded(item.itemKey, false)"
                :aria-label="`Toggle timeline for ${item.title}`"
                class="mt-0.5 inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded text-dimmed transition-colors hover:bg-elevated hover:text-default focus-visible:outline-2 focus-visible:outline-primary"
                type="button"
                @click="toggleItem(item.itemKey)"
              >
                <UIcon
                  class="size-3.5 transition-transform duration-150"
                  :class="isExpanded(item.itemKey, false) ? 'rotate-180' : ''"
                  name="i-lucide-chevron-down"
                />
              </button>
              <StatusDot
                class="mt-1.5"
                :status="item.rec.state === 'resolved' ? 'ok' : 'warn'"
              />
              <div class="min-w-0 flex-1 space-y-1">
                <button
                  :aria-expanded="isExpanded(item.itemKey, false)"
                  class="flex w-full cursor-pointer flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-left text-sm focus-visible:outline-2 focus-visible:outline-primary"
                  type="button"
                  @click="toggleItem(item.itemKey)"
                >
                  <div class="flex min-w-0 flex-wrap items-center gap-2">
                    <UBadge color="neutral" size="xs" variant="subtle">
                      {{ item.kind }}
                    </UBadge>
                    <span class="font-medium">{{ item.title }}</span>
                    <UBadge
                      v-if="item.delivery.muted"
                      color="neutral"
                      size="xs"
                      variant="subtle"
                    >
                      Muted
                    </UBadge>
                  </div>
                  <div
                    class="flex shrink-0 items-center gap-3 font-mono text-xs text-dimmed tabular-nums"
                  >
                    <span v-if="item.rec.duration_secs !== null">
                      {{ formatDuration(item.rec.duration_secs) }}
                    </span>
                    <UTooltip
                      :text="formatTimestamp(item.rec.started_at, true)"
                    >
                      <span>
                        {{ formatAge(item.rec.started_at, snap.now) }}
                      </span>
                    </UTooltip>
                  </div>
                </button>

                <button
                  :aria-expanded="isExpanded(item.itemKey, false)"
                  class="flex w-full cursor-pointer flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 text-left text-xs"
                  type="button"
                  @click="toggleItem(item.itemKey)"
                >
                  <span class="font-mono break-all text-muted">
                    {{ item.rec.summary }}
                  </span>
                  <UTooltip
                    v-if="item.delivery.detail && !item.delivery.muted"
                    :text="item.delivery.detail"
                  >
                    <span
                      class="shrink-0 font-mono text-[11px]"
                      :class="
                        item.delivery.warn
                          ? 'text-amber-600 underline decoration-dotted underline-offset-2 dark:text-amber-400'
                          : 'text-dimmed'
                      "
                    >
                      {{ item.delivery.text }}
                    </span>
                  </UTooltip>
                  <span
                    v-else-if="!item.delivery.muted"
                    class="shrink-0 font-mono text-[11px] text-dimmed"
                  >
                    {{ item.delivery.text }}
                  </span>
                </button>

                <div
                  v-if="isExpanded(item.itemKey, false)"
                  class="space-y-3 pt-3"
                >
                  <IncidentTimeline
                    :busy-key="timelineBusyKey(`auto:${item.rec.incident_key}`)"
                    can-add
                    :entries="item.timeline"
                    :now="snap.now"
                    show-public-toggle
                    @add="(p) => onAddAutoNote(item.rec.incident_key, p)"
                    @delete="
                      (id) => onDeleteAutoNote(item.rec.incident_key, id)
                    "
                    @edit="(p) => onEditAutoNote(item.rec.incident_key, p)"
                  />

                  <div class="flex items-center justify-between gap-2 pt-1">
                    <RouterLink
                      class="inline-flex items-center gap-1 text-xs font-medium text-muted transition-colors hover:text-primary"
                      :to="item.to"
                    >
                      <span>Open {{ item.targetName }}</span>
                      <UIcon class="size-3.5" name="i-lucide-arrow-up-right" />
                    </RouterLink>

                    <ConfirmPopover
                      color="error"
                      confirm-label="Delete"
                      label="Delete"
                      :loading="busy === `delhist:${item.rec.id}`"
                      @confirm="onDeleteHistory(item.rec, item.noteIds)"
                    >
                      Delete this incident from history?
                    </ConfirmPopover>
                  </div>
                </div>
              </div>
            </div>
          </template>
        </li>
      </ol>
    </section>

    <IncidentReportModal
      v-model:open="reportModalOpen"
      :report="editingReport"
    />
  </div>
</template>
