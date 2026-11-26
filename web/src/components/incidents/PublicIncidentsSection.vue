<script setup lang="ts">
import { computed, ref } from "vue";

import type {
  PublicIncidentReportSummary,
  PublicIncidentSummary,
} from "../../lib/index.ts";
import {
  INCIDENT_REPORT_STATUS_LABEL,
  formatAge,
  formatDuration,
  formatTimestamp,
  incidentReportBadgeColor,
  incidentReportDotStatus,
  incidentReportTimeline,
  publicAutoIncidentTimeline,
} from "../../lib/index.ts";
import StatusDot from "../ui/StatusDot.vue";
import IncidentTimeline from "./IncidentTimeline.vue";

const props = withDefaults(
  defineProps<{
    title: string;
    incidents: readonly PublicIncidentSummary[];
    reports?: readonly PublicIncidentReportSummary[];
    now: number;
    highlight?: boolean;
  }>(),
  {
    reports: () => [],
    highlight: false,
  },
);

const toggledKeys = ref(new Set<string>());

const hasItems = computed(
  () => props.reports.length > 0 || props.incidents.length > 0,
);

function isOpen(key: string, defaultOpen: boolean): boolean {
  const toggled = toggledKeys.value.has(key);

  return toggled ? !defaultOpen : defaultOpen;
}

function toggleKey(key: string) {
  const next = new Set(toggledKeys.value);
  if (next.has(key)) {
    next.delete(key);
  } else {
    next.add(key);
  }
  toggledKeys.value = next;
}
</script>

<template>
  <section v-if="hasItems" class="space-y-3">
    <h2 class="text-base font-semibold tracking-tight">{{ title }}</h2>

    <div
      class="divide-y divide-default"
      :class="
        highlight
          ? 'rounded-xl border border-amber-500/25 bg-amber-500/6 px-4 py-1'
          : 'border-y border-default'
      "
    >
      <article v-for="rep in reports" :key="rep.key" class="py-3">
        <button
          :aria-expanded="
            isOpen(
              rep.key,
              rep.resolved_at === null && rep.status !== 'resolved',
            )
          "
          class="flex w-full cursor-pointer flex-wrap items-center justify-between gap-x-4 gap-y-1.5 text-left text-sm focus-visible:outline-2 focus-visible:outline-primary"
          type="button"
          @click="toggleKey(rep.key)"
        >
          <div class="flex min-w-0 flex-wrap items-center gap-2">
            <StatusDot
              :status="incidentReportDotStatus(rep.status, rep.impact)"
            />
            <span class="font-semibold">{{ rep.title }}</span>
            <UBadge
              :color="incidentReportBadgeColor(rep.status, rep.impact)"
              size="xs"
              variant="subtle"
            >
              {{ INCIDENT_REPORT_STATUS_LABEL[rep.status] }}
            </UBadge>
            <UBadge
              v-for="name in rep.targets"
              :key="name"
              color="neutral"
              size="xs"
              variant="subtle"
            >
              {{ name }}
            </UBadge>
          </div>

          <div
            class="flex shrink-0 items-center gap-3 font-mono text-xs text-dimmed tabular-nums"
          >
            <span v-if="rep.updates.length > 0">
              {{ rep.updates.length }}
              {{ rep.updates.length === 1 ? "update" : "updates" }}
            </span>
            <span>
              {{
                formatDuration(
                  Math.max(0, (rep.resolved_at ?? now) - rep.created_at),
                )
              }}
            </span>
            <span :title="formatTimestamp(rep.created_at, true)">
              {{ formatAge(rep.created_at, now) }}
            </span>
            <UIcon
              class="size-3.5 text-muted transition-transform duration-150"
              :class="
                isOpen(
                  rep.key,
                  rep.resolved_at === null && rep.status !== 'resolved',
                )
                  ? 'rotate-180'
                  : ''
              "
              name="i-lucide-chevron-down"
            />
          </div>
        </button>

        <div
          v-if="
            isOpen(
              rep.key,
              rep.resolved_at === null && rep.status !== 'resolved',
            )
          "
          class="mt-3 pl-2"
        >
          <IncidentTimeline
            v-if="rep.updates.length > 0"
            :entries="incidentReportTimeline(rep.updates, rep.impact)"
            :now
          />
          <p v-else class="pl-4 text-xs text-dimmed">
            No timeline updates yet.
          </p>
        </div>
      </article>

      <article v-for="inc in incidents" :key="inc.key" class="py-3 text-sm">
        <button
          :aria-expanded="
            isOpen(
              inc.key,
              inc.state === 'open' && (inc.notes?.length ?? 0) > 0,
            )
          "
          class="flex w-full cursor-pointer flex-wrap items-center justify-between gap-x-4 gap-y-1.5 text-left focus-visible:outline-2 focus-visible:outline-primary"
          type="button"
          @click="toggleKey(inc.key)"
        >
          <div class="flex min-w-0 flex-wrap items-center gap-2">
            <StatusDot :status="inc.state === 'open' ? 'fail' : 'ok'" />
            <span class="font-semibold">{{ inc.name }}</span>
            <UBadge
              :color="inc.state === 'open' ? 'error' : 'success'"
              size="xs"
              variant="subtle"
            >
              {{ inc.state === "open" ? "Ongoing" : "Resolved" }}
            </UBadge>
            <span class="font-mono text-xs text-muted">{{ inc.reason }}</span>
          </div>

          <div
            class="flex shrink-0 items-center gap-3 font-mono text-xs text-dimmed tabular-nums"
          >
            <span>
              {{
                formatDuration(
                  Math.max(0, (inc.resolved_at ?? now) - inc.started_at),
                )
              }}
            </span>
            <span :title="formatTimestamp(inc.started_at, true)">
              {{
                inc.state === "open"
                  ? `Started ${formatAge(inc.started_at, now)}`
                  : formatTimestamp(inc.started_at, true)
              }}
            </span>
            <UIcon
              class="size-3.5 text-muted transition-transform duration-150"
              :class="
                isOpen(
                  inc.key,
                  inc.state === 'open' && (inc.notes?.length ?? 0) > 0,
                )
                  ? 'rotate-180'
                  : ''
              "
              name="i-lucide-chevron-down"
            />
          </div>
        </button>

        <div
          v-if="
            isOpen(
              inc.key,
              inc.state === 'open' && (inc.notes?.length ?? 0) > 0,
            )
          "
          class="mt-3 pl-2"
        >
          <IncidentTimeline
            :entries="
              publicAutoIncidentTimeline(
                inc.reason,
                inc.started_at,
                inc.resolved_at,
                inc.notes ?? [],
              )
            "
            :now
          />
        </div>
      </article>
    </div>
  </section>
</template>
