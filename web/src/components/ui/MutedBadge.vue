<script setup lang="ts">
import { formatRemaining, isPermanentMute } from "../../lib/index.ts";

defineProps<{
  until: number;
  now: number;
  compact?: boolean;
}>();
</script>

<template>
  <UBadge
    v-if="until > now"
    class="shrink-0"
    color="warning"
    size="xs"
    variant="subtle"
  >
    {{
      compact
        ? "Muted"
        : isPermanentMute(until)
          ? "Muted forever"
          : `Muted ${formatRemaining(until, now)}`
    }}
  </UBadge>
</template>
