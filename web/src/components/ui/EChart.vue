<script setup lang="ts">
import { useResizeObserver } from "@vueuse/core";
import type { EChartsCoreOption } from "echarts/core";
import { init } from "echarts/core";
import {
  onBeforeUnmount,
  onMounted,
  shallowRef,
  useTemplateRef,
  watch,
} from "vue";

const props = defineProps<{
  option: EChartsCoreOption;
  height?: string;
}>();

const rootEl = useTemplateRef<HTMLDivElement>("root");
const chart = shallowRef<ReturnType<typeof init> | null>(null);

onMounted(() => {
  if (!rootEl.value) {
    return;
  }
  const instance = init(rootEl.value);
  instance.setOption(props.option);
  chart.value = instance;
});

watch(
  () => props.option,
  (next) => {
    chart.value?.setOption(next, { notMerge: true });
  },
);

useResizeObserver(rootEl, () => {
  chart.value?.resize();
});

onBeforeUnmount(() => {
  chart.value?.dispose();
  chart.value = null;
});
</script>

<template>
  <div ref="root" class="w-full" :style="{ height: height ?? '200px' }" />
</template>
