<script setup lang="ts">
import { computed, ref } from "vue";

import type {
  CheckSnapshot,
  NodeSummary,
  SeriesSnapshot,
} from "../../lib/index.ts";
import {
  formatMountText,
  formatSeriesValue,
  mountPercent,
  statusTextClass,
} from "../../lib/index.ts";
import StatusDot from "../ui/StatusDot.vue";
import UsageBar from "../ui/UsageBar.vue";

const props = defineProps<{
  node: NodeSummary;
  scalarSeries: readonly SeriesSnapshot[];
}>();

const detailOverrides = ref<Record<string, boolean>>({});

const hasStorage = computed(() => props.node.mounts.length > 0);
const hasChecksOrSeries = computed(
  () => props.node.checks.length > 0 || props.scalarSeries.length > 0,
);

const isDetailOpen = (check: CheckSnapshot): boolean =>
  detailOverrides.value[check.key] ?? check.status !== "ok";

function toggleDetail(check: CheckSnapshot) {
  detailOverrides.value = {
    ...detailOverrides.value,
    [check.key]: !isDetailOpen(check),
  };
}

function scalarSummaryNote(series: SeriesSnapshot): string | null {
  if (!series.summary || !series.status || series.status === "ok") {
    return null;
  }
  const formatted = formatSeriesValue(series.value, series.unit);

  return series.summary.trim() === formatted ? null : series.summary;
}
</script>

<template>
  <section
    v-if="hasStorage || hasChecksOrSeries"
    class="grid grid-cols-1 items-start gap-8"
    :class="hasStorage && hasChecksOrSeries ? 'lg:grid-cols-2' : ''"
  >
    <div v-if="hasStorage" class="space-y-3">
      <h2 class="text-sm font-semibold">Storage</h2>
      <div class="divide-y divide-default border-y border-default">
        <div v-for="m in node.mounts" :key="m.path" class="space-y-2 py-3.5">
          <div
            class="flex flex-wrap items-baseline justify-between gap-2 text-xs"
          >
            <div class="flex items-baseline gap-2">
              <span class="font-semibold">{{ m.label ?? m.path }}</span>
              <span v-if="m.label" class="font-mono text-dimmed">
                {{ m.path }}
              </span>
            </div>
            <span
              class="font-mono tabular-nums"
              :class="statusTextClass(m.status)"
            >
              {{ formatMountText(m, true) }}
            </span>
          </div>
          <UsageBar :pct="mountPercent(m)" :status="m.status" />
        </div>
      </div>
    </div>

    <div v-if="hasChecksOrSeries" class="space-y-3">
      <h2 class="text-sm font-semibold">Checks</h2>
      <div class="divide-y divide-default border-y border-default">
        <div v-for="c in node.checks" :key="c.key" class="space-y-2 py-3.5">
          <div class="flex items-center justify-between gap-3 text-[13px]">
            <div class="flex min-w-0 items-center gap-2">
              <StatusDot :status="c.status" />
              <span class="truncate font-medium">{{ c.label }}</span>
              <UBadge
                v-if="c.group"
                class="shrink-0"
                color="neutral"
                size="xs"
                variant="subtle"
              >
                {{ c.group }}
              </UBadge>
            </div>
            <div class="flex shrink-0 items-center gap-2">
              <span
                class="font-mono text-xs"
                :class="statusTextClass(c.status)"
              >
                {{ c.summary ?? c.status }}
              </span>
              <button
                v-if="c.detail"
                :aria-expanded="isDetailOpen(c)"
                :aria-label="`Toggle details for ${c.label}`"
                class="inline-flex size-6 items-center justify-center rounded-md text-dimmed transition-colors hover:bg-elevated hover:text-default"
                type="button"
                @click="toggleDetail(c)"
              >
                <UIcon
                  class="size-3.5 transition-transform"
                  :class="isDetailOpen(c) ? 'rotate-180' : ''"
                  name="i-lucide-chevron-down"
                />
              </button>
            </div>
          </div>
          <pre
            v-if="c.detail && isDetailOpen(c)"
            class="max-h-56 overflow-auto rounded-lg bg-muted p-3 font-mono text-xs leading-relaxed"
            >{{ c.detail }}</pre>
        </div>

        <div
          v-for="s in scalarSeries"
          :key="s.key"
          class="space-y-1.5 py-3.5 text-[13px]"
        >
          <div class="flex items-center justify-between gap-3">
            <div class="flex min-w-0 items-center gap-2">
              <StatusDot :status="s.status ?? 'pending'" />
              <span class="truncate font-medium">{{ s.label }}</span>
              <UBadge
                v-if="s.group"
                class="shrink-0"
                color="neutral"
                size="xs"
                variant="subtle"
              >
                {{ s.group }}
              </UBadge>
            </div>
            <span
              class="shrink-0 font-mono text-xs tabular-nums"
              :class="statusTextClass(s.status ?? 'ok')"
            >
              {{ formatSeriesValue(s.value, s.unit) }}
            </span>
          </div>
          <p
            v-if="scalarSummaryNote(s)"
            class="pl-4 font-mono text-xs break-all"
            :class="statusTextClass(s.status ?? 'ok')"
          >
            {{ scalarSummaryNote(s) }}
          </p>
        </div>
      </div>
    </div>
  </section>

  <section v-if="node.info.length > 0" class="space-y-3">
    <h2 class="text-sm font-semibold">System</h2>
    <div
      class="grid grid-cols-2 gap-6 border-y border-default py-4 sm:grid-cols-4"
    >
      <div v-for="item in node.info" :key="item.key" class="space-y-0.5">
        <div class="text-xs text-dimmed">{{ item.label }}</div>
        <div class="font-mono text-xs break-all">{{ item.value }}</div>
      </div>
    </div>
  </section>
</template>
