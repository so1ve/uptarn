<script setup lang="ts">
import type { PublicMaintenanceSummary } from "../../lib/index.ts";
import {
  formatDuration,
  formatRemaining,
  formatTimestamp,
} from "../../lib/index.ts";

defineProps<{
  maintenances: readonly PublicMaintenanceSummary[];
  now: number;
}>();
</script>

<template>
  <section v-if="maintenances.length > 0" class="space-y-2.5">
    <div
      v-for="m in maintenances"
      :key="m.key"
      class="space-y-1.5 rounded-xl border px-4 py-3 text-sm"
      :class="
        m.state === 'active'
          ? 'border-amber-500/25 bg-amber-500/8'
          : 'border-default bg-surface'
      "
    >
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div class="flex min-w-0 flex-wrap items-center gap-2">
          <UIcon
            class="size-4 shrink-0"
            :class="
              m.state === 'active'
                ? 'text-amber-600 dark:text-amber-400'
                : 'text-muted'
            "
            name="i-lucide-wrench"
          />
          <span class="font-semibold">{{ m.title }}</span>
          <UBadge
            :color="m.state === 'active' ? 'warning' : 'neutral'"
            size="xs"
            variant="subtle"
          >
            {{ m.state === "active" ? "In progress" : "Scheduled" }}
          </UBadge>
        </div>

        <span class="font-mono text-xs text-muted tabular-nums">
          <template v-if="m.state === 'active'">
            Ends in {{ formatRemaining(m.ends_at, now) }}
          </template>
          <template v-else>
            {{ formatTimestamp(m.starts_at, true) }} ·
            {{ formatDuration(m.ends_at - m.starts_at) }}
          </template>
        </span>
      </div>

      <p
        v-if="m.body"
        class="pl-6 text-xs leading-relaxed whitespace-pre-line text-muted"
      >
        {{ m.body }}
      </p>

      <div
        v-if="m.targets.length > 0"
        class="flex flex-wrap items-center gap-1.5 pl-6 pt-0.5"
      >
        <UBadge
          v-for="name in m.targets"
          :key="name"
          color="neutral"
          size="xs"
          variant="subtle"
        >
          {{ name }}
        </UBadge>
      </div>
    </div>
  </section>
</template>
