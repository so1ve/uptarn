<script setup lang="ts">
import { computed, onMounted, watch } from "vue";
import { useRoute, useRouter } from "vue-router";

import AdminShell from "./layouts/AdminShell.vue";
import { useUptarnStore } from "./lib/index.ts";
import LoginView from "./views/LoginView.vue";
import PublicStatusView from "./views/PublicStatusView.vue";

const route = useRoute();
const router = useRouter();
const { publicStatus, snapshot, loadError, loadState, refreshPublicStatus } =
  useUptarnStore();

const isAdminPublicView = computed(
  () => snapshot.value !== null && route.name === "public-status",
);

const hasPublicContent = computed(
  () =>
    publicStatus.value !== null &&
    (publicStatus.value.monitors.length > 0 ||
      publicStatus.value.nodes.length > 0),
);

watch(
  [snapshot, publicStatus, () => route.path],
  ([admin, pub, path]) => {
    if (!admin && pub && path !== "/") {
      void router.replace("/");
    }
  },
  { immediate: true },
);

watch(
  isAdminPublicView,
  (active) => {
    if (active) {
      loadError.value = null;
      void refreshPublicStatus({ force: true });
    }
  },
  { immediate: true },
);

function onRetry() {
  if (isAdminPublicView.value) {
    loadError.value = null;
    void refreshPublicStatus({ force: true });

    return;
  }
  void loadState();
}

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
        <UButton block color="neutral" variant="soft" @click="onRetry">
          Retry
        </UButton>
      </div>
    </div>

    <PublicStatusView
      v-else-if="isAdminPublicView && publicStatus"
      admin-preview
      :status="publicStatus"
    />

    <div
      v-else-if="isAdminPublicView"
      class="grid min-h-svh place-items-center text-xs text-dimmed"
    >
      Loading…
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
