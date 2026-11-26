<script setup lang="ts">
import type { SecretSource } from "../../lib/index.ts";

const emit = defineEmits<{
  clear: [];
  undo: [];
}>();

defineProps<{
  source: SecretSource;
  clearing: boolean;
  optional?: boolean;
}>();
</script>

<template>
  <span
    v-if="clearing"
    class="inline-flex items-center gap-1.5 text-xs text-warning"
  >
    Clear on save
    <button
      class="underline hover:text-default"
      type="button"
      @click="emit('undo')"
    >
      Undo
    </button>
  </span>
  <span
    v-else-if="source === 'db'"
    class="inline-flex items-center gap-1.5 text-xs text-muted"
  >
    Saved
    <button
      class="underline hover:text-default"
      type="button"
      @click="emit('clear')"
    >
      Clear
    </button>
  </span>
  <span v-else-if="source === 'env'" class="text-xs text-muted">
    From environment
  </span>
  <span v-else-if="optional" class="text-xs text-muted">Optional</span>
</template>
