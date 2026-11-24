<script setup lang="ts">
import { RouterLink } from "vue-router";

defineProps<{
  host?: string;
  to?: string;
}>();
</script>

<template>
  <component
    :is="to ? RouterLink : 'div'"
    class="flex min-w-0 items-center gap-2"
    v-bind="to ? { to } : {}"
  >
    <img
      alt=""
      class="shrink-0 rounded-md"
      height="22"
      src="/favicon.svg"
      width="22"
    />
    <span class="text-[15px] font-semibold tracking-tight">uptarn</span>
    <template v-if="host">
      <span class="text-dimmed">/</span>
      <span class="truncate font-mono text-xs text-muted">{{ host }}</span>
    </template>
  </component>
</template>
