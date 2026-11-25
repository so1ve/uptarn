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
  formatSeriesWithLoss,
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

const WINDOWS = [
  { label: "1h", value: 3600 },
  { label: "6h", value: 21_600 },
  { label: "24h", value: 86_400 },
  { label: "7d", value: 604_800 },
] as const;

const { isDark } = useUptarnStore();

const windowOptions = computed(() =>
  WINDOWS.map((w) => ({
    ...w,
    loading: Boolean(props.loadingWindow && windowSecs.value === w.value),
  })),
);
const showDate = computed(() => windowSecs.value > 86_400);
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
      <ChartCard v-if="computeChartOption" :option="computeChartOption">
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

      <ChartCard v-if="networkChartOption" :option="networkChartOption">
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
        v-for="item in probeCharts"
        :key="item.series.key"
        :option="item.option"
      >
        <template #title>
          <h3 class="inline-flex items-center gap-2 text-sm font-semibold">
            <StatusDot :status="item.series.status ?? 'ok'" />
            {{ item.series.label }}
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
