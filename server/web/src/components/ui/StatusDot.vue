<script setup lang="ts">
import type { DotStatus } from "../../lib/index.ts";
import { statusDotClass } from "../../lib/index.ts";

withDefaults(
  defineProps<{
    status: DotStatus;
    sizeClass?: string;
  }>(),
  { sizeClass: "size-2" },
);
</script>

<template>
  <span
    class="shrink-0 rounded-full"
    :class="[sizeClass, statusDotClass(status)]"
  />
</template>
