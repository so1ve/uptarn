<script setup lang="ts">
import type { EChartsCoreOption } from "echarts/core";

import EChart from "./EChart.vue";

withDefaults(
  defineProps<{
    option: EChartsCoreOption | null;
    height?: string;
    emptyText?: string;
    compact?: boolean;
  }>(),
  { height: "220px", emptyText: undefined, compact: false },
);
</script>

<template>
  <div
    class="rounded-xl border border-default bg-surface"
    :class="compact ? 'p-4' : 'p-5'"
  >
    <div
      v-if="$slots.title || $slots.meta"
      class="mb-3 flex flex-wrap items-center justify-between gap-2"
    >
      <slot name="title" />
      <slot name="meta" />
    </div>
    <EChart v-if="option" :height :option />
    <p v-else-if="emptyText" class="py-4 text-center text-xs text-dimmed">
      {{ emptyText }}
    </p>
  </div>
</template>
