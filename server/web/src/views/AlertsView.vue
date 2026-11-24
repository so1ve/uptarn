<script setup lang="ts">
import { computed } from "vue";

import PageHeader from "../components/ui/PageHeader.vue";
import StatusDot from "../components/ui/StatusDot.vue";
import type { IncidentSummary } from "../lib/index.ts";
import {
  deliveryStatus,
  formatAge,
  formatDuration,
  formatRemaining,
  incidentRoute,
  splitIncident,
  targetMutedUntil,
  useAction,
  useSnapshot,
} from "../lib/index.ts";

const snap = useSnapshot();
const { busy, mute } = useAction();

const openCount = computed(
  () => snap.value.incidents.filter((i) => i.state === "open").length,
);

const incidentRows = computed(() =>
  snap.value.incidents.map((inc) => {
    const mutedUntil = targetMutedUntil(
      snap.value,
      inc.target_type,
      inc.target_id,
    );

    return {
      inc,
      ...splitIncident(inc),
      to: incidentRoute(inc),
      mutedUntil,
      isMuted: mutedUntil > snap.value.now,
    };
  }),
);

const eventRows = computed(() =>
  snap.value.events.map((ev) => ({
    ev,
    delivery: deliveryStatus(ev.delivery),
  })),
);

const onToggleMute = (inc: IncidentSummary, isMuted: boolean) =>
  mute(
    inc.incident_key,
    inc.target_type,
    inc.target_id,
    splitIncident(inc).title,
    isMuted ? 0 : 3600,
  );
</script>

<template>
  <div class="space-y-8">
    <PageHeader title="Alerts" />

    <section aria-labelledby="active-issues-heading" class="space-y-3">
      <div class="flex items-baseline gap-2">
        <h2 id="active-issues-heading" class="text-sm font-semibold">
          Active issues
        </h2>
        <span class="text-xs text-dimmed tabular-nums">
          {{ incidentRows.length }}
        </span>
      </div>

      <div
        v-if="incidentRows.length === 0"
        class="rounded-xl border border-default bg-elevated px-5 py-6 text-sm text-muted"
      >
        No active issues.
      </div>

      <ul
        v-else
        class="divide-y divide-default rounded-xl p-1"
        :class="openCount > 0 ? 'bg-red-500/8' : 'bg-amber-500/10'"
      >
        <li
          v-for="{ inc, kind, title, to, mutedUntil, isMuted } in incidentRows"
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
            <UBadge v-if="isMuted" color="warning" size="xs" variant="subtle">
              Muted {{ formatRemaining(mutedUntil, snap.now) }}
            </UBadge>
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
            <UButton
              color="neutral"
              :loading="busy === inc.incident_key"
              size="xs"
              variant="ghost"
              @click="onToggleMute(inc, isMuted)"
            >
              {{ isMuted ? "Unmute" : "Mute 1h" }}
            </UButton>
          </div>
        </li>
      </ul>
    </section>

    <section aria-labelledby="history-heading" class="space-y-3">
      <div class="flex items-baseline gap-2">
        <h2 id="history-heading" class="text-sm font-semibold">
          Alert history
        </h2>
        <span class="text-xs text-dimmed tabular-nums">
          {{ eventRows.length }}
        </span>
      </div>

      <div
        v-if="eventRows.length === 0"
        class="rounded-xl border border-default bg-elevated px-5 py-6 text-sm text-muted"
      >
        No events yet.
      </div>

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
