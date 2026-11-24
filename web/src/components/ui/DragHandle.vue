<script setup lang="ts">
const emit = defineEmits<{
  moveUp: [];
  moveDown: [];
}>();

defineProps<{
  label: string;
}>();
</script>

<template>
  <button
    :aria-label="`Drag to reorder ${label} (Alt+ArrowUp or Alt+ArrowDown)`"
    class="inline-flex size-5 shrink-0 cursor-grab items-center justify-center rounded text-dimmed/60 transition-colors hover:text-default active:cursor-grabbing"
    title="Drag to reorder"
    type="button"
    @click.stop
    @keydown.alt.down.prevent.stop="emit('moveDown')"
    @keydown.alt.up.prevent.stop="emit('moveUp')"
  >
    <UIcon class="size-3.5" name="i-lucide-grip-vertical" />
  </button>
</template>
