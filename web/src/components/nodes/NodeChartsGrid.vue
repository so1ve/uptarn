<script setup lang="ts">
import { computed } from "vue";

import type {
  NodeSummary,
  ProbeChartItem,
  SeriesPoint,
} from "../../lib/index.ts";
import {
  buildComputeChartOption,
  buildLoadChart,
  buildNetworkChartOption,
  formatBps,
  formatSeriesWithLoss,
  hasLiveNodeSamples,
  memPercent,
  useUptarnStore,
} from "../../lib/index.ts";
import ChartCard from "../ui/ChartCard.vue";
import SegmentedControl from "../ui/SegmentedControl.vue";
import StatusDot from "../ui/StatusDot.vue";

const props = defineProps<{
  node: NodeSummary;
  history: Record<string, SeriesPoint[]>;
  probeCharts: readonly ProbeChartItem[];
  loadingWindow?: boolean;
}>();

const windowSecs = defineModel<number>("windowSecs", { required: true });

const HISTORY_WINDOWS = [
  { label: "1h", value: 3600 },
  { label: "6h", value: 21_600 },
  { label: "24h", value: 86_400 },
  { label: "7d", value: 604_800 },
] as const;

const { isDark, liveConnected } = useUptarnStore();

const hasLive = computed(() => hasLiveNodeSamples(props.node.id));
const isLiveWindow = computed(() => windowSecs.value === 0);
const windowOptions = computed(() => {
  const items = hasLive.value
    ? [{ label: "Live", value: 0 }, ...HISTORY_WINDOWS]
    : [...HISTORY_WINDOWS];

  return items.map((w) => ({
    ...w,
    loading: Boolean(props.loadingWindow && windowSecs.value === w.value),
  }));
});
const showDate = computed(() => windowSecs.value > 86_400);
const memPct = computed(() => memPercent(props.node.system));
const systemResetKey = computed(() => `${props.node.id}:${windowSecs.value}`);
const probeResetKey = computed(
  () => `${props.node.id}:${isLiveWindow.value ? 21_600 : windowSecs.value}`,
);
const computeChartOption = computed(() =>
  buildComputeChartOption(
    props.history,
    isDark.value,
    showDate.value,
    isLiveWindow.value,
  ),
);
const networkChartOption = computed(() =>
  buildNetworkChartOption(
    props.history,
    isDark.value,
    showDate.value,
    isLiveWindow.value,
  ),
);
const loadChart = computed(() =>
  buildLoadChart(
    props.history,
    isDark.value,
    showDate.value,
    isLiveWindow.value,
  ),
);
const wideLoadCard = computed(
  () =>
    loadChart.value !== null &&
    computeChartOption.value !== null &&
    networkChartOption.value !== null &&
    props.probeCharts.length === 0,
);
const totalCharts = computed(
  () =>
    (computeChartOption.value ? 1 : 0) +
    (networkChartOption.value ? 1 : 0) +
    (loadChart.value ? 1 : 0) +
    props.probeCharts.length,
);
</script>

<template>
  <section v-if="totalCharts > 0" class="space-y-3">
    <div class="flex items-center justify-between gap-3">
      <div class="flex items-center gap-2.5">
        <h2 class="text-sm font-semibold">Metrics</h2>
        <span
          v-if="liveConnected && hasLive && isLiveWindow"
          class="inline-flex items-center gap-1.5 font-mono text-[11px] text-emerald-600 dark:text-emerald-400"
        >
          <span class="relative flex size-1.5">
            <span
              class="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-75"
            />
            <span
              class="relative inline-flex size-1.5 rounded-full bg-emerald-500"
            />
          </span>
          3s live
        </span>
      </div>
      <SegmentedControl
        v-model="windowSecs"
        aria-label="Metrics time window"
        mono
        :options="windowOptions"
      />
    </div>

    <div
      class="grid grid-cols-1 gap-5"
      :class="totalCharts >= 2 ? 'lg:grid-cols-2' : ''"
    >
      <ChartCard
        v-if="computeChartOption"
        :option="computeChartOption"
        :reset-key="systemResetKey"
      >
        <template #title>
          <h3 class="text-sm font-semibold">CPU &amp; Memory</h3>
        </template>
        <template #meta>
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
        </template>
      </ChartCard>

      <ChartCard
        v-if="networkChartOption"
        :option="networkChartOption"
        :reset-key="systemResetKey"
      >
        <template #title>
          <h3 class="text-sm font-semibold">Network</h3>
        </template>
        <template #meta>
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
        </template>
      </ChartCard>

      <ChartCard
        v-if="loadChart"
        :class="wideLoadCard ? 'lg:col-span-2' : ''"
        :height="wideLoadCard ? '175px' : '220px'"
        :option="loadChart.option"
        :reset-key="systemResetKey"
      >
        <template #title>
          <h3 class="text-sm font-semibold">Load</h3>
        </template>
        <template #meta>
          <div
            class="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-xs tabular-nums"
          >
            <span
              v-if="node.system?.load_1m !== undefined"
              class="inline-flex items-center gap-1.5 text-muted"
            >
              <span class="size-2 rounded-xs bg-teal-500" />
              {{ node.system.load_1m.toFixed(2) }}
            </span>
            <span class="text-dimmed">avg {{ loadChart.avg.toFixed(2) }}</span>
            <span class="text-dimmed">
              peak {{ loadChart.peak.toFixed(2) }}
            </span>
          </div>
        </template>
      </ChartCard>

      <ChartCard
        v-for="item in probeCharts"
        :key="item.series.key"
        :option="item.option"
        :reset-key="probeResetKey"
      >
        <template #title>
          <h3 class="inline-flex items-center gap-2 text-sm font-semibold">
            <StatusDot :status="item.series.status ?? 'ok'" />
            {{ item.series.label }}
            <span
              v-if="isLiveWindow"
              class="font-mono text-[10.5px] font-normal text-dimmed"
            >
              6h
            </span>
          </h3>
        </template>
        <template #meta>
          <div
            class="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-xs tabular-nums"
          >
            <span>
              {{
                formatSeriesWithLoss(
                  item.series.value,
                  item.series.unit,
                  item.series.loss_pct,
                )
              }}
            </span>
            <span class="text-dimmed">{{ item.stats }}</span>
          </div>
        </template>
      </ChartCard>
    </div>
  </section>
</template>
