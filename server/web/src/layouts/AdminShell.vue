<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useRoute } from "vue-router";

import IssuedTokenModal from "../components/modals/IssuedTokenModal.vue";
import SettingsModal from "../components/modals/SettingsModal.vue";
import {
  apiFetch,
  formatRemaining,
  useAction,
  useLiveRefresh,
  useSnapshot,
  useUptarnStore,
} from "../lib/index.ts";
import AppLayout from "./AppLayout.vue";

const route = useRoute();
const snap = useSnapshot();
const { busy, run } = useAction();
const { signOutState } = useUptarnStore();

const settingsOpen = ref(false);

const totalIssues = computed(() => snap.value.incidents.length);
const globalMuted = computed(
  () => snap.value.settings.global_muted_until > snap.value.now,
);

const pageTitle = computed(() => {
  if (route.name === "node-detail") {
    const id = String(route.params.id ?? "");

    return snap.value.nodes.find((n) => n.id === id)?.label ?? id;
  }
  const titles: Record<string, string> = {
    monitors: "Monitors",
    jobs: "Jobs",
    alerts: "Alerts",
  };

  return titles[String(route.name)] ?? "Nodes";
});

const navItems = computed(() => [
  {
    to: "/",
    label: "Nodes",
    active: route.name === "nodes" || route.name === "node-detail",
    count: snap.value.nodes.length,
    alert: false,
  },
  {
    to: "/monitors",
    label: "Monitors",
    active: route.name === "monitors",
    count: snap.value.monitors.length,
    alert: false,
  },
  {
    to: "/jobs",
    label: "Jobs",
    active: route.name === "jobs",
    count: snap.value.jobs.length,
    alert: false,
  },
  {
    to: "/alerts",
    label: "Alerts",
    active: route.name === "alerts",
    count: totalIssues.value,
    alert: totalIssues.value > 0,
  },
]);

watch(
  pageTitle,
  (title) => {
    document.title = `${title} - Uptarn`;
  },
  { immediate: true },
);

useLiveRefresh("admin", 10_000, 3000);

const onCheckNow = () =>
  run(
    "tick",
    "Check failed",
    async () => {
      await apiFetch("/api/v1/admin/tick", "POST");

      return "Checks completed";
    },
    true,
  );

async function onSignOut() {
  await apiFetch("/api/v1/auth/logout", "POST").catch(() => {});
  await signOutState();
}
</script>

<template>
  <AppLayout home-to="/" :version="snap.version">
    <template #nav>
      <nav aria-label="Primary" class="flex items-center gap-1">
        <RouterLink
          v-for="item in navItems"
          :key="item.to"
          class="inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[13px] font-medium transition-colors"
          :class="
            item.active
              ? 'bg-elevated text-highlighted'
              : 'text-muted hover:bg-elevated/70 hover:text-default'
          "
          :to="item.to"
        >
          <span>{{ item.label }}</span>
          <span
            v-if="item.count > 0"
            class="rounded-full px-1.5 py-0.5 font-mono text-[10.5px] leading-none tabular-nums"
            :class="
              item.alert
                ? 'bg-red-500/15 text-red-600 dark:text-red-400'
                : 'text-dimmed'
            "
          >
            {{ item.count }}
          </span>
        </RouterLink>
      </nav>
    </template>

    <template #actions-prefix>
      <UBadge
        v-if="globalMuted"
        class="mr-1"
        color="warning"
        size="xs"
        variant="subtle"
      >
        {{
          `Muted ${formatRemaining(snap.settings.global_muted_until, snap.now)}`
        }}
      </UBadge>
      <UButton
        color="neutral"
        icon="i-lucide-refresh-cw"
        :loading="busy === 'tick'"
        size="sm"
        variant="ghost"
        @click="onCheckNow"
      >
        <span class="hidden sm:inline">Check now</span>
      </UButton>
      <UButton
        color="neutral"
        icon="i-lucide-sliders-horizontal"
        size="sm"
        variant="ghost"
        @click="settingsOpen = true"
      >
        <span class="hidden sm:inline">Settings</span>
      </UButton>
    </template>

    <template #actions>
      <UButton color="neutral" size="sm" variant="ghost" @click="onSignOut">
        Sign out
      </UButton>
    </template>

    <RouterView />

    <SettingsModal v-model:open="settingsOpen" />
    <IssuedTokenModal />
  </AppLayout>
</template>
