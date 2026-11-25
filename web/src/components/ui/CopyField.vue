<script setup lang="ts">
import { useAction } from "../../lib/index.ts";

withDefaults(
  defineProps<{
    label: string;
    value: string;
    copyLabel?: string;
    buttonText?: string;
  }>(),
  { copyLabel: undefined, buttonText: undefined },
);

const { copy } = useAction();
</script>

<template>
  <UFormField :label>
    <div class="flex items-center gap-2">
      <UInput class="flex-1 font-mono" :model-value="value" readonly />
      <UButton
        v-if="value"
        :aria-label="`Copy ${(copyLabel ?? label).toLowerCase()}`"
        color="neutral"
        icon="i-lucide-copy"
        size="sm"
        variant="soft"
        @click="copy(value, copyLabel ?? label)"
      >
        {{ buttonText }}
      </UButton>
      <slot />
    </div>
  </UFormField>
</template>
