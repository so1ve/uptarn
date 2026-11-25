<script setup lang="ts">
defineEmits<{
  retry: [];
}>();

defineProps<{
  description: string;
}>();
</script>

<template>
  <div class="grid min-h-svh place-items-center px-4">
    <div class="w-full max-w-sm space-y-4">
      <UAlert
        color="error"
        :description
        icon="i-lucide-circle-alert"
        title="Could not connect to Uptarn"
        variant="subtle"
      />
      <UButton block color="neutral" variant="soft" @click="$emit('retry')">
        Retry
      </UButton>
    </div>
  </div>
</template>
