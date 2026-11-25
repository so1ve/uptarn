<script setup lang="ts" generic="T extends string | number">
export interface SegmentedOption<V extends string | number = string | number> {
  value: V;
  label: string;
  icon?: string;
  loading?: boolean;
}

defineProps<{
  options: readonly SegmentedOption<T>[];
  mono?: boolean;
}>();

const model = defineModel<T>({ required: true });
</script>

<template>
  <div class="inline-flex items-center rounded-lg bg-muted p-0.5" role="group">
    <UButton
      v-for="opt in options"
      :key="String(opt.value)"
      :class="mono ? 'px-2 font-mono' : undefined"
      color="neutral"
      :icon="opt.icon"
      :loading="opt.loading"
      size="xs"
      :variant="model === opt.value ? 'solid' : 'ghost'"
      @click="model = opt.value"
    >
      {{ opt.label }}
    </UButton>
  </div>
</template>
