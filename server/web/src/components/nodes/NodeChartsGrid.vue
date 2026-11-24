<script setup lang="ts">
import { computed } from "vue";

import type { NodeSummary, ProbeChartItem } from "../../lib/index.ts";
import {
  buildComputeChartOption,
  formatSeriesValue,
  memPercent,
  useUptarnStore,
} from "../../lib/index.ts";
import EChart from "../ui/EChart.vue";
import StatusDot from "../ui/StatusDot.vue";

const props = defineProps<{
  node: NodeSummary;
  probeCharts: readonly ProbeChartItem[];
}>();

const { isDark } = useUptarnStore();

const memPct = computed(() => memPercent(props.node.system));
const computeChartOption = computed(() =>
  buildComputeChartOption(props.node, isDark.value),
);
const totalCharts = computed(
  () => (computeChartOption.value ? 1 : 0) + props.probeCharts.length,
);
</script>

<template>
  <section
    v-if="totalCharts > 0"
    class="grid grid-cols-1 gap-5"
    :class="totalCharts >= 2 ? 'lg:grid-cols-2' : ''"
  >
    <div
      v-if="computeChartOption"
      class="rounded-xl border border-default bg-elevated p-5"
    >
      <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 class="text-sm font-semibold">CPU &amp; Memory</h2>
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
          <span v-if="memPct !== null" class="inline-flex items-center gap-1.5">
            <span class="size-2 rounded-xs bg-violet-500" />
            Memory {{ memPct.toFixed(1) }}%
          </span>
        </div>
      </div>
      <EChart height="220px" :option="computeChartOption" />
    </div>

    <div
      v-for="item in probeCharts"
      :key="item.series.key"
      class="rounded-xl border border-default bg-elevated p-5"
    >
      <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 class="inline-flex items-center gap-2 text-sm font-semibold">
          <StatusDot :status="item.series.status ?? 'ok'" />
          {{ item.series.label }}
        </h2>
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
  </section>
</template>
