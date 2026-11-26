<script setup lang="ts">
import StatusDot from "./StatusDot.vue";

defineProps<{
  tone: "ok" | "warn" | "fail";
  title: string;
  to?: string;
}>();

const STYLES = {
  fail: { bg: "bg-red-500/10", text: "text-red-600 dark:text-red-400" },
  warn: { bg: "bg-amber-500/10", text: "text-amber-600 dark:text-amber-400" },
  ok: {
    bg: "bg-emerald-500/10",
    text: "text-emerald-700 dark:text-emerald-400",
  },
} as const;
</script>

<template>
  <component
    :is="to ? 'RouterLink' : 'div'"
    class="flex items-center justify-between gap-3 rounded-xl px-4 py-3 text-sm"
    :class="[STYLES[tone].bg, to ? 'transition-opacity hover:opacity-90' : '']"
    :to="to || undefined"
  >
    <div class="flex min-w-0 flex-1 items-center gap-2.5">
      <StatusDot size-class="size-2.5" :status="tone" />
      <span
        class="shrink-0 font-semibold whitespace-nowrap"
        :class="STYLES[tone].text"
      >
        {{ title }}
      </span>
      <slot />
    </div>
    <slot name="trailing" />
  </component>
</template>
