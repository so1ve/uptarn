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
  resetKey?: string | number;
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
  [() => props.option, () => props.resetKey],
  ([nextOption, nextKey], [, prevKey]) => {
    const instance = chart.value;
    if (!instance) {
      return;
    }
    if (nextKey === prevKey) {
      instance.setOption(
        { ...nextOption, animation: false },
        { replaceMerge: ["series"] },
      );
    } else {
      instance.setOption(nextOption, { notMerge: true });
    }
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
