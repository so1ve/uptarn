<script setup lang="ts">
import { computed } from "vue";

import EmptyState from "../components/ui/EmptyState.vue";
import MuteButton from "../components/ui/MuteButton.vue";
import MutedBadge from "../components/ui/MutedBadge.vue";
import PageHeader from "../components/ui/PageHeader.vue";
import StatusDot from "../components/ui/StatusDot.vue";
import {
  deliveryStatus,
  formatAge,
  formatDuration,
  incidentRoute,
  splitIncident,
  targetMutedUntil,
  useSnapshot,
} from "../lib/index.ts";

const snap = useSnapshot();

const openCount = computed(
  () => snap.value.incidents.filter((i) => i.state === "open").length,
);

const incidentRows = computed(() =>
  snap.value.incidents.map((inc) => ({
    inc,
    ...splitIncident(inc),
    to: incidentRoute(inc),
    mutedUntil: targetMutedUntil(snap.value, inc.target_type, inc.target_id),
  })),
);

const eventRows = computed(() =>
  snap.value.events.map((ev) => ({
    ev,
    delivery: deliveryStatus(ev.delivery),
  })),
);
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
        :class="openCount > 0 ? 'bg-red-500/8' : 'bg-amber-500/10'"
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
            <MutedBadge :now="snap.now" :until="mutedUntil" />
            <span class="font-mono text-xs break-all text-muted">
              {{ inc.last_summary }}
            </span>
          </div>

          <div class="flex shrink-0 items-center gap-3">
            <span class="font-mono text-xs text-muted tabular-nums">
              {{
                inc.opened_at === null
                  ? `${inc.consecutive_failures} ${inc.consecutive_failures === 1 ? "failure" : "failures"}`
                  : formatDuration(snap.now - inc.opened_at)
              }}
            </span>
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
      <div class="flex items-baseline gap-2">
        <h2 id="history-heading" class="text-sm font-semibold">History</h2>
        <span class="text-xs text-dimmed tabular-nums">
          {{ eventRows.length }}
        </span>
      </div>

      <EmptyState v-if="eventRows.length === 0">
        No incident history yet.
      </EmptyState>

      <ol v-else class="divide-y divide-default border-y border-default">
        <li
          v-for="{ ev, delivery } in eventRows"
          :key="ev.id"
          class="flex items-start gap-3 py-3.5"
        >
          <StatusDot
            class="mt-1.5"
            :status="ev.kind === 'firing' ? 'fail' : 'ok'"
          />
          <div class="min-w-0 flex-1 space-y-0.5">
            <div
              class="flex flex-wrap items-baseline justify-between gap-2 text-sm"
            >
              <div class="flex items-center gap-2">
                <span class="font-medium">{{ ev.label }}</span>
                <UBadge
                  :color="ev.kind === 'firing' ? 'error' : 'success'"
                  size="xs"
                  variant="subtle"
                >
                  {{ ev.kind === "firing" ? "Firing" : "Resolved" }}
                </UBadge>
              </div>
              <span class="shrink-0 font-mono text-xs text-dimmed tabular-nums">
                {{ formatAge(ev.created_at, snap.now) }}
              </span>
            </div>
            <div
              class="flex flex-wrap items-baseline justify-between gap-2 text-xs"
            >
              <span class="font-mono break-all text-muted">
                {{ ev.summary }}
              </span>
              <span
                class="shrink-0 font-mono text-[11px]"
                :class="
                  delivery.warn
                    ? 'text-amber-600 dark:text-amber-400'
                    : 'text-dimmed'
                "
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
