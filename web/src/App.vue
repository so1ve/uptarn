<script setup lang="ts">
import { computed, onMounted } from "vue";

import AdminShell from "./layouts/AdminShell.vue";
import { useUptarnStore } from "./lib/index.ts";
import LoginView from "./views/LoginView.vue";
import PublicStatusView from "./views/PublicStatusView.vue";

const { publicStatus, snapshot, loadError, loadState } = useUptarnStore();

const hasPublicContent = computed(
  () =>
    publicStatus.value !== null &&
    (publicStatus.value.monitors.length > 0 ||
      publicStatus.value.nodes.length > 0),
);

onMounted(() => {
  void loadState();
});
</script>

<template>
  <UApp :toaster="{ position: 'bottom-right' }">
    <div v-if="loadError" class="grid min-h-svh place-items-center px-4">
      <div class="w-full max-w-sm space-y-4">
        <UAlert
          color="error"
          :description="loadError"
          icon="i-lucide-circle-alert"
          title="Could not connect to Uptarn"
          variant="subtle"
        />
        <UButton block color="neutral" variant="soft" @click="loadState">
          Retry
        </UButton>
      </div>
    </div>

    <AdminShell v-else-if="snapshot" />

    <PublicStatusView
      v-else-if="publicStatus && hasPublicContent"
      :status="publicStatus"
    />

    <LoginView v-else-if="publicStatus" :status="publicStatus" />

    <div v-else class="grid min-h-svh place-items-center text-xs text-dimmed">
      Loading…
    </div>
  </UApp>
</template>
