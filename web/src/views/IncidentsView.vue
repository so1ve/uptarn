<script setup lang="ts">
import { computed, ref } from "vue";

import EmptyState from "../components/ui/EmptyState.vue";
import MuteButton from "../components/ui/MuteButton.vue";
import MutedBadge from "../components/ui/MutedBadge.vue";
import PageHeader from "../components/ui/PageHeader.vue";
import SegmentedControl from "../components/ui/SegmentedControl.vue";
import StatusDot from "../components/ui/StatusDot.vue";
import type { IncidentSummary, TargetType } from "../lib/index.ts";
import {
  apiFetch,
  deliveryStatus,
  formatAge,
  formatDuration,
  formatTimestamp,
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

const FILTER_OPTIONS = [
  { value: "all" as const, label: "All" },
  { value: "node" as const, label: "Nodes" },
  { value: "monitor" as const, label: "Monitors" },
  { value: "job" as const, label: "Jobs" },
];

const historyFilter = ref<"all" | TargetType>("all");
const historyQuery = ref("");

const unackedCount = computed(
  () => snap.value.incidents.filter((i) => i.acknowledged_at === null).length,
);
const unackedOpenCount = computed(
  () =>
    snap.value.incidents.filter(
      (i) => i.acknowledged_at === null && i.state === "open",
    ).length,
);

const activeListClass = computed(() => {
  if (unackedOpenCount.value > 0) {
    return "bg-red-500/8";
  }
  if (unackedCount.value > 0) {
    return "bg-amber-500/10";
  }

  return "bg-elevated/60";
});

const incidentRows = computed(() =>
  snap.value.incidents.map((inc) => ({
    inc,
    ...splitIncident(inc),
    to: incidentRoute(inc),
    mutedUntil: targetMutedUntil(snap.value, inc.target_type, inc.target_id),
  })),
);

const allHistoryRows = computed(() => {
  const activeKeys = new Set(snap.value.incidents.map((i) => i.incident_key));

  return pairIncidentEvents(snap.value.events, activeKeys).map((rec) => {
    const { kind, subject } = splitAlertLabel(rec.target_type, rec.label);

    return {
      rec,
      kind,
      title: rec.target_type === "node" ? rec.label : subject,
      to: incidentTargetPath(rec.target_type, rec.target_id),
      delivery: deliveryStatus(rec.firing_delivery, rec.resolved_delivery),
    };
  });
});

const filteredHistoryRows = computed(() => {
  const query = historyQuery.value.trim().toLowerCase();

  return allHistoryRows.value.filter(({ rec, title }) => {
    if (
      historyFilter.value !== "all" &&
      rec.target_type !== historyFilter.value
    ) {
      return false;
    }
    if (!query) {
      return true;
    }

    return (
      title.toLowerCase().includes(query) ||
      rec.label.toLowerCase().includes(query) ||
      rec.summary.toLowerCase().includes(query) ||
      rec.target_id.toLowerCase().includes(query)
    );
  });
});

function onToggleAck(inc: IncidentSummary) {
  const acknowledged = inc.acknowledged_at === null;

  return run(
    `ack:${inc.incident_key}`,
    "Could not update incident",
    async () => {
      await apiFetch("/api/v1/admin/incidents/ack", "POST", {
        incident_key: inc.incident_key,
        acknowledged,
      });

      return acknowledged ? "Incident acknowledged" : "Acknowledgement cleared";
    },
    true,
  );
}
</script>

<template>
  <div class="space-y-8">
    <PageHeader title="Incidents" />

    <section aria-labelledby="active-incidents-heading" class="space-y-3">
      <div class="flex items-baseline gap-2">
        <h2 id="active-incidents-heading" class="text-sm font-semibold">
          Active incidents
        </h2>
        <span class="text-xs text-dimmed tabular-nums">
          {{ incidentRows.length }}
        </span>
      </div>

      <EmptyState v-if="incidentRows.length === 0">
        No active incidents.
      </EmptyState>

      <ul
        v-else
        class="divide-y divide-default rounded-xl p-1"
        :class="activeListClass"
      >
        <li
          v-for="{ inc, kind, title, to, mutedUntil } in incidentRows"
          :key="inc.incident_key"
          class="flex flex-wrap items-center justify-between gap-3 px-3.5 py-3"
        >
          <div class="flex min-w-0 flex-1 flex-wrap items-center gap-2.5">
            <StatusDot :status="inc.state === 'open' ? 'fail' : 'warn'" />
            <UBadge color="neutral" size="xs" variant="subtle">
              {{ kind }}
            </UBadge>
            <RouterLink
              class="text-sm font-semibold transition-colors hover:text-primary"
              :to
            >
              {{ title }}
            </RouterLink>
            <UBadge
              v-if="inc.acknowledged_at !== null"
              color="neutral"
              size="xs"
              variant="subtle"
            >
              Acked
            </UBadge>
            <MutedBadge :now="snap.now" :until="mutedUntil" />
            <span class="font-mono text-xs break-all text-muted">
              {{ inc.last_summary }}
            </span>
          </div>

          <div class="flex shrink-0 items-center gap-2">
            <span class="mr-1 font-mono text-xs text-muted tabular-nums">
              {{
                inc.opened_at === null
                  ? `${inc.consecutive_failures} ${inc.consecutive_failures === 1 ? "failure" : "failures"}`
                  : formatDuration(snap.now - inc.opened_at)
              }}
            </span>
            <UButton
              color="neutral"
              :icon="
                inc.acknowledged_at === null
                  ? 'i-lucide-check'
                  : 'i-lucide-rotate-ccw'
              "
              :loading="busy === `ack:${inc.incident_key}`"
              size="xs"
              variant="soft"
              @click="onToggleAck(inc)"
            >
              {{ inc.acknowledged_at === null ? "Ack" : "Unack" }}
            </UButton>
            <MuteButton
              :label="title"
              :muted-until
              :now="snap.now"
              :target-id="inc.target_id"
              :target-type="inc.target_type"
            />
          </div>
        </li>
      </ul>
    </section>

    <section aria-labelledby="history-heading" class="space-y-3">
      <div class="flex flex-wrap items-center justify-between gap-2.5">
        <div class="flex items-baseline gap-2">
          <h2 id="history-heading" class="text-sm font-semibold">History</h2>
          <span class="text-xs text-dimmed tabular-nums">
            {{ filteredHistoryRows.length }}
          </span>
        </div>

        <div
          v-if="allHistoryRows.length > 0"
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

      <EmptyState v-if="allHistoryRows.length === 0">
        No incident history yet.
      </EmptyState>

      <EmptyState v-else-if="filteredHistoryRows.length === 0">
        No matching incidents.
      </EmptyState>

      <ol v-else class="divide-y divide-default border-y border-default">
        <li
          v-for="{ rec, kind, title, to, delivery } in filteredHistoryRows"
          :key="`${rec.incident_key}:${rec.id}`"
          class="flex items-start gap-3 py-3.5"
        >
          <StatusDot
            class="mt-1.5"
            :status="rec.state === 'resolved' ? 'ok' : 'warn'"
          />
          <div class="min-w-0 flex-1 space-y-1">
            <div
              class="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-sm"
            >
              <div class="flex min-w-0 flex-wrap items-center gap-2">
                <UBadge color="neutral" size="xs" variant="subtle">
                  {{ kind }}
                </UBadge>
                <RouterLink
                  class="font-medium transition-colors hover:text-primary"
                  :to
                >
                  {{ title }}
                </RouterLink>
                <UBadge
                  v-if="delivery.muted"
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
                <span v-if="rec.duration_secs !== null">
                  {{ formatDuration(rec.duration_secs) }}
                </span>
                <UTooltip :text="formatTimestamp(rec.started_at, true)">
                  <span>{{ formatAge(rec.started_at, snap.now) }}</span>
                </UTooltip>
              </div>
            </div>
            <div
              class="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 text-xs"
            >
              <span class="font-mono break-all text-muted">
                {{ rec.summary }}
              </span>
              <UTooltip
                v-if="delivery.detail && !delivery.muted"
                :text="delivery.detail"
              >
                <span
                  class="shrink-0 font-mono text-[11px]"
                  :class="
                    delivery.warn
                      ? 'text-amber-600 underline decoration-dotted underline-offset-2 dark:text-amber-400'
                      : 'text-dimmed'
                  "
                >
                  {{ delivery.text }}
                </span>
              </UTooltip>
              <span
                v-else-if="!delivery.muted"
                class="shrink-0 font-mono text-[11px] text-dimmed"
              >
                {{ delivery.text }}
              </span>
            </div>
          </div>
        </li>
      </ol>
    </section>
  </div>
</template>
