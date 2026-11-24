<script setup lang="ts">
import { computed } from "vue";

import type {
  NodeSummary,
  ProbeChartItem,
  SeriesPoint,
} from "../../lib/index.ts";
import {
  buildComputeChartOption,
  buildNetworkChartOption,
  formatBps,
  formatSeriesValue,
  memPercent,
  useUptarnStore,
} from "../../lib/index.ts";
import EChart from "../ui/EChart.vue";
import StatusDot from "../ui/StatusDot.vue";

const emit = defineEmits<{
  "update:windowSecs": [secs: number];
}>();

const props = defineProps<{
  node: NodeSummary;
  history: Record<string, SeriesPoint[]>;
  probeCharts: readonly ProbeChartItem[];
  windowSecs: number;
  loadingWindow?: boolean;
}>();

const WINDOWS = [
  { label: "1h", secs: 3600 },
  { label: "6h", secs: 21_600 },
  { label: "24h", secs: 86_400 },
  { label: "7d", secs: 604_800 },
] as const;

const { isDark } = useUptarnStore();

const showDate = computed(() => props.windowSecs > 86_400);
const memPct = computed(() => memPercent(props.node.system));
const computeChartOption = computed(() =>
  buildComputeChartOption(
    props.node,
    isDark.value,
    props.history,
    showDate.value,
  ),
);
const networkChartOption = computed(() =>
  buildNetworkChartOption(
    props.node,
    isDark.value,
    props.history,
    showDate.value,
  ),
);
const totalCharts = computed(
  () =>
    (computeChartOption.value ? 1 : 0) +
    (networkChartOption.value ? 1 : 0) +
    props.probeCharts.length,
);
</script>

<template>
  <section v-if="totalCharts > 0" class="space-y-3">
    <div class="flex items-center justify-between gap-3">
      <h2 class="text-sm font-semibold">Metrics</h2>
      <div class="inline-flex items-center gap-1">
        <UButton
          v-for="w in WINDOWS"
          :key="w.secs"
          class="font-mono"
          color="neutral"
          :loading="loadingWindow && windowSecs === w.secs"
          size="xs"
          :variant="windowSecs === w.secs ? 'soft' : 'ghost'"
          @click="emit('update:windowSecs', w.secs)"
        >
          {{ w.label }}
        </UButton>
      </div>
    </div>

    <div
      class="grid grid-cols-1 gap-5"
      :class="totalCharts >= 2 ? 'lg:grid-cols-2' : ''"
    >
      <div
        v-if="computeChartOption"
        class="rounded-xl border border-default bg-surface p-5"
      >
        <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h3 class="text-sm font-semibold">CPU &amp; Memory</h3>
          <div
            class="flex items-center gap-4 font-mono text-xs text-muted tabular-nums"
          >
            <span
              v-if="node.system?.cpu_pct !== undefined"
              class="inline-flex items-center gap-1.5"
            >
              <span class="size-2 rounded-xs bg-blue-500" />
              CPU {{ node.system.cpu_pct.toFixed(1) }}%
            </span>
            <span
              v-if="memPct !== null"
              class="inline-flex items-center gap-1.5"
            >
              <span class="size-2 rounded-xs bg-violet-500" />
              Memory {{ memPct.toFixed(1) }}%
            </span>
          </div>
        </div>
        <EChart height="220px" :option="computeChartOption" />
      </div>

      <div
        v-if="networkChartOption"
        class="rounded-xl border border-default bg-surface p-5"
      >
        <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h3 class="text-sm font-semibold">Network</h3>
          <div
            v-if="node.rx_bps !== null && node.tx_bps !== null"
            class="flex items-center gap-4 font-mono text-xs text-muted tabular-nums"
          >
            <span class="inline-flex items-center gap-1.5">
              <span class="size-2 rounded-xs bg-blue-500" />
              ↓ {{ formatBps(node.rx_bps) }}
            </span>
            <span class="inline-flex items-center gap-1.5">
              <span class="size-2 rounded-xs bg-violet-500" />
              ↑ {{ formatBps(node.tx_bps) }}
            </span>
          </div>
        </div>
        <EChart height="220px" :option="networkChartOption" />
      </div>

      <div
        v-for="item in probeCharts"
        :key="item.series.key"
        class="rounded-xl border border-default bg-surface p-5"
      >
        <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h3 class="inline-flex items-center gap-2 text-sm font-semibold">
            <StatusDot :status="item.series.status ?? 'ok'" />
            {{ item.series.label }}
          </h3>
          <div
            class="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-xs tabular-nums"
          >
            <span>
              {{
                `${formatSeriesValue(item.series.value, item.series.unit)}${item.series.loss_pct !== undefined && item.series.loss_pct > 0 ? `, ${Math.round(item.series.loss_pct)}% loss` : ""}`
              }}
            </span>
            <span class="text-dimmed">{{ item.stats }}</span>
          </div>
        </div>
        <EChart height="220px" :option="item.option" />
      </div>
    </div>
  </section>
</template>
