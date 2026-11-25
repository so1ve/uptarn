<script setup lang="ts">
import type { HealthStatus } from "../../lib/index.ts";
import { clampPct } from "../../lib/index.ts";

const props = withDefaults(
  defineProps<{
    pct: number;
    status?: HealthStatus;
    barClass?: string;
    heightClass?: string;
  }>(),
  { status: undefined, barClass: undefined, heightClass: "h-1.5" },
);

function resolvedBarClass() {
  if (props.barClass) {
    return props.barClass;
  }
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
    class="w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800"
    :class="heightClass"
  >
    <div
      class="h-full rounded-full"
      :class="resolvedBarClass()"
      :style="{ width: `${clampPct(pct)}%` }"
    />
  </div>
</template>
