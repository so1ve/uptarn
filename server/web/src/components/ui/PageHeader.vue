<script setup lang="ts">
defineProps<{
  title: string;
}>();
</script>

<template>
  <div class="flex flex-wrap items-center justify-between gap-4">
    <h1 class="text-xl font-semibold tracking-tight">{{ title }}</h1>
    <div v-if="$slots.default" class="flex flex-wrap items-center gap-2">
      <slot />
    </div>
  </div>
</template>
