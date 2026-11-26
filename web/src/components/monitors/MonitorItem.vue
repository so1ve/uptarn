<script setup lang="ts">
import { computed } from "vue";

import type {
  MonitorSummary,
  MonitorWindow,
  PublicIncidentSummary,
  PublicMonitorSummary,
} from "../../lib/index.ts";
import {
  buildMonitorLatencyOption,
  monitorLatencyStats,
  useUptarnStore,
} from "../../lib/index.ts";
import ChartCard from "../ui/ChartCard.vue";
import MonitorRow from "./MonitorRow.vue";

const emit = defineEmits<{
  toggle: [];
  edit: [];
  moveUp: [];
  moveDown: [];
}>();

const props = defineProps<{
  monitor: MonitorSummary | PublicMonitorSummary;
  now: number;
  window: MonitorWindow;
  expanded: boolean;
  reorderable?: boolean;
  incidents?: readonly PublicIncidentSummary[];
}>();

const { isDark } = useUptarnStore();

const canExpand = computed(() =>
  "probe" in props.monitor
    ? props.monitor.probe.type !== "exec"
    : props.monitor.has_latency,
);

const stats = computed(() =>
  props.expanded && canExpand.value
    ? monitorLatencyStats(props.monitor, props.window, props.now)
    : null,
);

const chartOption = computed(() =>
  props.expanded && canExpand.value
    ? buildMonitorLatencyOption(
        props.monitor,
        isDark.value,
        props.window,
        props.now,
      )
    : null,
);
</script>

<template>
  <MonitorRow
    :expanded="expanded && canExpand"
    :incidents
    :monitor
    :now
    :reorderable
    :window
    @edit="emit('edit')"
    @move-down="emit('moveDown')"
    @move-up="emit('moveUp')"
    @toggle="canExpand && emit('toggle')"
  />

  <ChartCard
    v-if="expanded && canExpand"
    class="mb-4 sm:ml-6"
    compact
    empty-text="No samples yet."
    height="180px"
    :option="chartOption"
    :reset-key="window"
  >
    <template #title>
      <span class="font-mono text-xs text-muted tabular-nums">
        {{ stats ?? "" }}
      </span>
    </template>
    <template v-if="$slots['chart-meta']" #meta>
      <slot name="chart-meta" />
    </template>
  </ChartCard>
</template>
