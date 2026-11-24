<script setup lang="ts">
import type { MonitorWindow } from "../../lib/index.ts";
import { MONITOR_WINDOWS } from "../../lib/index.ts";

const model = defineModel<MonitorWindow>({ default: "24h" });
</script>

<template>
  <div
    aria-label="Uptime window"
    class="inline-flex items-center rounded-lg bg-muted p-0.5"
    role="group"
  >
    <UButton
      v-for="w in MONITOR_WINDOWS"
      :key="w.id"
      class="font-mono"
      color="neutral"
      size="xs"
      :variant="model === w.id ? 'solid' : 'ghost'"
      @click="model = w.id"
    >
      {{ w.label }}
    </UButton>
  </div>
</template>
