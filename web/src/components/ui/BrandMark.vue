<script setup lang="ts">
import { RouterLink } from "vue-router";

import { useUptarnStore } from "../../lib/index.ts";

defineProps<{
  host?: string;
  to?: string;
}>();

const { isDark } = useUptarnStore();
</script>

<template>
  <component
    :is="to ? RouterLink : 'div'"
    class="flex min-w-0 items-center gap-2"
    v-bind="to ? { to } : {}"
  >
    <img
      alt=""
      class="shrink-0"
      height="22"
      :src="isDark ? '/logo-dark.svg' : '/logo-light.svg'"
      width="22"
    />
    <span class="shrink-0 text-[15px] font-semibold tracking-tight">
      Uptarn
    </span>
    <template v-if="host">
      <span class="hidden text-dimmed sm:inline">/</span>
      <span class="hidden truncate font-mono text-xs text-muted sm:inline">
        {{ host }}
      </span>
    </template>
  </component>
</template>
