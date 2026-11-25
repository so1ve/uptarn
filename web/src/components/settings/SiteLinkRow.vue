<script setup lang="ts">
import type { SiteLink } from "../../lib/index.ts";

const emit = defineEmits<{
  update: [field: keyof SiteLink, value: string];
  remove: [];
}>();

defineProps<{
  link: SiteLink;
}>();
</script>

<template>
  <div
    class="grid grid-cols-[minmax(7rem,10rem)_minmax(0,1fr)_auto] items-center gap-2"
  >
    <UInput
      aria-label="Link label"
      class="w-full"
      :maxlength="32"
      :model-value="link.label"
      placeholder="Homepage"
      required
      size="sm"
      @update:model-value="emit('update', 'label', String($event))"
    />
    <UInput
      aria-label="Link URL"
      class="w-full font-mono"
      :model-value="link.url"
      placeholder="https://example.com"
      required
      size="sm"
      type="url"
      @update:model-value="emit('update', 'url', String($event))"
    />
    <UButton
      aria-label="Remove link"
      color="neutral"
      icon="i-lucide-x"
      size="xs"
      type="button"
      variant="ghost"
      @click="emit('remove')"
    />
  </div>
</template>
