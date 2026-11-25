<script setup lang="ts">
import { computed, onMounted, watch } from "vue";
import { useRoute, useRouter } from "vue-router";

import ConnectionError from "./components/ui/ConnectionError.vue";
import LoadingShell from "./components/ui/LoadingShell.vue";
import { useUptarnStore } from "./lib/index.ts";

const route = useRoute();
const router = useRouter();
const { publicStatus, snapshot, loadError, loadState, refreshPublicStatus } =
  useUptarnStore();

const booted = computed(
  () => snapshot.value !== null || publicStatus.value !== null,
);
const requiresAuth = computed(() => Boolean(route.meta.requiresAuth));
const canRenderRoute = computed(
  () =>
    booted.value &&
    route.matched.length > 0 &&
    (!requiresAuth.value || snapshot.value !== null),
);
const loadingVariant = computed(() => route.meta.loading ?? "public");

watch(
  [booted, snapshot, requiresAuth],
  ([isBooted, admin, needsAuth]) => {
    if (isBooted && needsAuth && !admin) {
      void router.replace("/");
    }
  },
  { immediate: true },
);

function onRetry() {
  loadError.value = null;
  if (snapshot.value && !publicStatus.value) {
    void refreshPublicStatus({ force: true });
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
    <ConnectionError
      v-if="loadError"
      :description="loadError"
      @retry="onRetry"
    />
    <RouterView v-else-if="canRenderRoute" />
    <LoadingShell v-else :variant="loadingVariant" />
  </UApp>
</template>
