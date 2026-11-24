<script setup lang="ts">
import { computed } from "vue";

import type { SeriesPoint } from "../../lib/index.ts";
import {
  buildSparkOption,
  sparkLineColor,
  usageTextClass,
  useUptarnStore,
} from "../../lib/index.ts";
import EChart from "./EChart.vue";

const props = defineProps<{
  kind: "cpu" | "memory";
  pct: number;
  history: readonly SeriesPoint[];
  caption?: string;
}>();

const { isDark } = useUptarnStore();

const thresholds = computed(() =>
  props.kind === "cpu"
    ? {
        label: "CPU",
        warn: 75,
        fail: 90,
        darkHex: "#60a5fa",
        lightHex: "#2563eb",
        barClass: "bg-blue-500",
        display: `${props.pct.toFixed(props.pct < 10 ? 1 : 0)}%`,
      }
    : {
        label: "Memory",
        warn: 80,
        fail: 92,
        darkHex: "#a78bfa",
        lightHex: "#7c3aed",
        barClass: "bg-violet-500",
        display: `${Math.round(props.pct)}%`,
      },
);

const option = computed(() =>
  props.history.length >= 2
    ? buildSparkOption(
        props.history,
        sparkLineColor(
          props.pct,
          thresholds.value.warn,
          thresholds.value.fail,
          isDark.value,
          thresholds.value.darkHex,
          thresholds.value.lightHex,
        ),
        isDark.value,
      )
    : null,
);
</script>

<template>
  <div class="space-y-1">
    <div class="flex items-baseline justify-between gap-2">
      <span class="text-xs text-muted">{{ thresholds.label }}</span>
      <span
        class="text-base font-semibold tracking-tight tabular-nums"
        :class="usageTextClass(pct, thresholds.warn, thresholds.fail)"
      >
        {{ thresholds.display }}
      </span>
    </div>
    <EChart v-if="option" height="32px" :option />
    <div
      v-else
      class="h-1 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800"
    >
      <div
        class="h-full rounded-full"
        :class="thresholds.barClass"
        :style="{ width: `${Math.min(100, Math.max(0, pct))}%` }"
      />
    </div>
    <div v-if="caption" class="font-mono text-[11px] text-dimmed tabular-nums">
      {{ caption }}
    </div>
  </div>
</template>
