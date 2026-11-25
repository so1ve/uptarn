<script setup lang="ts">
import type { PublicIncidentSummary } from "../../lib/index.ts";
import { formatAge, formatDuration, formatTimestamp } from "../../lib/index.ts";
import StatusDot from "../ui/StatusDot.vue";

defineProps<{
  title: string;
  incidents: readonly PublicIncidentSummary[];
  now: number;
  highlight?: boolean;
}>();
</script>

<template>
  <section v-if="incidents.length > 0" class="space-y-3">
    <h2 class="text-base font-semibold tracking-tight">{{ title }}</h2>

    <ol
      class="divide-y divide-default"
      :class="
        highlight
          ? 'rounded-xl bg-red-500/8 px-4 py-1'
          : 'border-y border-default'
      "
    >
      <li
        v-for="inc in incidents"
        :key="inc.key"
        class="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 py-3 text-sm"
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
        </div>
      </li>
    </ol>
  </section>
</template>
