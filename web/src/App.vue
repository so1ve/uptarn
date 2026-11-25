<script setup lang="ts">
import { computed, onMounted, watch } from "vue";
import { useRoute, useRouter } from "vue-router";

import LoadingShell from "./components/ui/LoadingShell.vue";
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

const loadingVariant = computed<"public" | "admin-cards" | "admin-list">(() => {
  if (route.path === "/" || route.name === "public-status") {
    return "public";
  }

  return route.name === "nodes" || route.path === "/admin"
    ? "admin-cards"
    : "admin-list";
});

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

function loadAdminPublic() {
  loadError.value = null;
  void refreshPublicStatus({ force: true });
}

watch(
  isAdminPublicView,
  (active) => {
    if (active) {
      loadAdminPublic();
    }
  },
  { immediate: true },
);

function onRetry() {
  if (isAdminPublicView.value) {
    loadAdminPublic();
  } else {
    void loadState();
  }
}

onMounted(() => {
  void loadState();
});
</script>

<template>
  <UApp :scroll-body="false" :toaster="{ position: 'bottom-right' }">
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
      v-else-if="
        publicStatus && (isAdminPublicView || (!snapshot && hasPublicContent))
      "
      :admin-preview="isAdminPublicView"
      :status="publicStatus"
    />

    <AdminShell v-else-if="snapshot && !isAdminPublicView" />

    <LoginView
      v-else-if="!isAdminPublicView && publicStatus"
      :status="publicStatus"
    />

    <LoadingShell v-else :variant="loadingVariant" />
  </UApp>
</template>
