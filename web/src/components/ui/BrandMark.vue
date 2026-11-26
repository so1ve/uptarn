<script setup lang="ts">
import { computed } from "vue";
import { RouterLink } from "vue-router";

import { useUptarnStore } from "../../lib/index.ts";

const props = defineProps<{
  title?: string | null;
  host?: string;
  to?: string;
}>();

const { isDark } = useUptarnStore();
const baseUrl = import.meta.env.BASE_URL;
const displayTitle = computed(() => props.title || "Uptarn");
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
      :src="`${baseUrl}${isDark ? 'logo-dark.svg' : 'logo-light.svg'}`"
      width="22"
    />
    <span
      class="min-w-0 truncate text-[15px] font-semibold tracking-tight"
      :title="displayTitle"
    >
      {{ displayTitle }}
    </span>
    <template v-if="host">
      <span class="hidden shrink-0 text-dimmed md:inline">/</span>
      <span
        class="hidden min-w-0 shrink-[2] truncate font-mono text-xs text-muted md:inline"
        :title="host"
      >
        {{ host }}
      </span>
    </template>
  </component>
</template>
