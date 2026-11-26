<script setup lang="ts">
import { ref } from "vue";

const emit = defineEmits<{
  confirm: [];
}>();

withDefaults(
  defineProps<{
    label: string;
    confirmLabel?: string;
    color?: "neutral" | "error" | "primary";
    confirmColor?: "error" | "primary";
    variant?: "ghost" | "soft";
    size?: "xs" | "sm";
    loading?: boolean;
  }>(),
  {
    confirmLabel: undefined,
    color: "neutral",
    confirmColor: "error",
    variant: "ghost",
    size: "xs",
    loading: false,
  },
);

const open = ref(false);

function handleConfirm() {
  open.value = false;
  emit("confirm");
}
</script>

<template>
  <UPopover v-model:open="open">
    <UButton class="whitespace-nowrap" :color :loading :size :variant>
      {{ label }}
    </UButton>
    <template #content>
      <div class="w-56 space-y-3 p-3 text-xs">
        <p class="leading-relaxed text-default">
          <slot />
        </p>
        <div class="flex justify-end gap-1.5">
          <UButton
            color="neutral"
            size="xs"
            variant="ghost"
            @click="open = false"
          >
            Cancel
          </UButton>
          <UButton :color="confirmColor" size="xs" @click="handleConfirm">
            {{ confirmLabel ?? label }}
          </UButton>
        </div>
      </div>
    </template>
  </UPopover>
</template>
