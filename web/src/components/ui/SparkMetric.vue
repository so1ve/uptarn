<script setup lang="ts">
import { computed } from "vue";

import type { SeriesPoint } from "../../lib/index.ts";
import {
  buildSparkOption,
  usageTextClass,
  useUptarnStore,
} from "../../lib/index.ts";
import EChart from "./EChart.vue";
import UsageBar from "./UsageBar.vue";

const props = defineProps<{
  kind: "cpu" | "memory";
  pct: number;
  history: readonly SeriesPoint[];
  caption?: string;
}>();

const { isDark } = useUptarnStore();

const cfg = computed(() =>
  props.kind === "cpu"
    ? {
        label: "CPU",
        warn: 75,
        fail: 90,
        hex: isDark.value ? "#60a5fa" : "#2563eb",
        barClass: "bg-blue-500",
        display: `${props.pct.toFixed(props.pct < 10 ? 1 : 0)}%`,
      }
    : {
        label: "Memory",
        warn: 80,
        fail: 92,
        hex: isDark.value ? "#a78bfa" : "#7c3aed",
        barClass: "bg-violet-500",
        display: `${Math.round(props.pct)}%`,
      },
);

const option = computed(() => {
  if (props.history.length < 2) {
    return null;
  }
  const color =
    props.pct >= cfg.value.fail
      ? "#ef4444"
      : props.pct >= cfg.value.warn
        ? "#f59e0b"
        : cfg.value.hex;

  return buildSparkOption(props.history, color, isDark.value);
});
</script>

<template>
  <div class="space-y-1">
    <div class="flex items-baseline justify-between gap-2">
      <span class="text-xs text-muted">{{ cfg.label }}</span>
      <span
        class="text-base font-semibold tracking-tight tabular-nums"
        :class="usageTextClass(pct, cfg.warn, cfg.fail)"
      >
        {{ cfg.display }}
      </span>
    </div>
    <EChart v-if="option" height="32px" :option />
    <UsageBar v-else :bar-class="cfg.barClass" height-class="h-1" :pct />
    <div v-if="caption" class="font-mono text-[11px] text-dimmed tabular-nums">
      {{ caption }}
    </div>
  </div>
</template>
