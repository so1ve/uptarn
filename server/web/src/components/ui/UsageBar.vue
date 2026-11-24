<script setup lang="ts">
import type { HealthStatus } from "../../lib/index.ts";

const props = defineProps<{
  pct: number;
  status?: HealthStatus;
}>();

function barClass() {
  const s =
    props.status ??
    (props.pct >= 92 ? "fail" : props.pct >= 85 ? "warn" : "ok");

  return s === "fail"
    ? "bg-red-500"
    : s === "warn"
      ? "bg-amber-500"
      : "bg-zinc-500 dark:bg-zinc-400";
}
</script>

<template>
  <div
    class="h-1.5 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800"
  >
    <div
      class="h-full rounded-full"
      :class="barClass()"
      :style="{ width: `${Math.min(100, Math.max(0, pct))}%` }"
    />
  </div>
</template>
