<script setup lang="ts">
import { computed, onMounted } from "vue";

import LoadingShell from "../components/ui/LoadingShell.vue";
import { useUptarnStore } from "../lib/index.ts";
import LoginView from "./LoginView.vue";
import PublicStatusView from "./PublicStatusView.vue";

const { publicStatus, snapshot, loadError, refreshPublicStatus } =
  useUptarnStore();

const adminPreview = computed(() => snapshot.value !== null);
const hasPublicContent = computed(
  () =>
    publicStatus.value !== null &&
    (publicStatus.value.monitors.length > 0 ||
      publicStatus.value.nodes.length > 0),
);

onMounted(() => {
  if (adminPreview.value && !publicStatus.value) {
    loadError.value = null;
    void refreshPublicStatus({ force: true });
  }
});
</script>

<template>
  <LoadingShell v-if="!publicStatus" variant="public" />
  <PublicStatusView
    v-else-if="adminPreview || hasPublicContent"
    :admin-preview
    :status="publicStatus"
  />
  <LoginView v-else :status="publicStatus" />
</template>
