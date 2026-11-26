<script setup lang="ts">
import type { DotStatus } from "../../lib/index.ts";

withDefaults(
  defineProps<{
    status: DotStatus;
    sizeClass?: string;
  }>(),
  { sizeClass: "size-2" },
);

const dotClass = (status: DotStatus) =>
  status === "ok"
    ? "bg-emerald-500"
    : status === "running"
      ? "bg-sky-500 animate-pulse"
      : status === "warn"
        ? "bg-amber-500"
        : status === "pending"
          ? "bg-zinc-400 dark:bg-zinc-600"
          : "bg-red-500";
</script>

<template>
  <span class="shrink-0 rounded-full" :class="[sizeClass, dotClass(status)]" />
</template>
