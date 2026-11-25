<script setup lang="ts">
import { computed, watch } from "vue";
import { useRoute } from "vue-router";

import IssuedTokenModal from "../components/modals/IssuedTokenModal.vue";
import MutedBadge from "../components/ui/MutedBadge.vue";
import StatusBanner from "../components/ui/StatusBanner.vue";
import {
  apiFetch,
  splitIncident,
  useAction,
  useLiveRefresh,
  useSnapshot,
  useUptarnStore,
} from "../lib/index.ts";
import AppLayout from "./AppLayout.vue";

const ROUTE_TITLES: Record<string, string> = {
  monitors: "Monitors",
  jobs: "Jobs",
  incidents: "Incidents",
  maintenances: "Maintenances",
  settings: "Settings",
};

const route = useRoute();
const snap = useSnapshot();
const { busy, run } = useAction();
const { signOutState } = useUptarnStore();

const totalIncidents = computed(() => snap.value.incidents.length);
const activeMaintenancesCount = computed(
  () => snap.value.maintenances.filter((m) => m.state !== "completed").length,
);
const openIncidents = computed(
  () => snap.value.incidents.filter((i) => i.state === "open").length,
);
const incidentHeadline = computed(() => {
  const titles = snap.value.incidents
    .slice(0, 3)
    .map((inc) => splitIncident(inc).title)
    .join(", ");
  const extra = snap.value.incidents.length - 3;

  return extra > 0 ? `${titles} +${extra} more` : titles;
});

const pageTitle = computed(() => {
  if (route.name === "node-detail") {
    const id = String(route.params.id ?? "");

    return snap.value.nodes.find((n) => n.id === id)?.label ?? id;
  }

  return ROUTE_TITLES[String(route.name)] ?? "Nodes";
});

const navItems = computed(() => [
  {
    to: "/admin",
    label: "Nodes",
    active: route.name === "nodes" || route.name === "node-detail",
    count: snap.value.nodes.length,
    urgent: false,
  },
  {
    to: "/admin/monitors",
    label: "Monitors",
    active: route.name === "monitors",
    count: snap.value.monitors.length,
    urgent: false,
  },
  {
    to: "/admin/jobs",
    label: "Jobs",
    active: route.name === "jobs",
    count: snap.value.jobs.length,
    urgent: false,
  },
  {
    to: "/admin/incidents",
    label: "Incidents",
    active: route.name === "incidents",
    count: totalIncidents.value,
    urgent: totalIncidents.value > 0,
  },
  {
    to: "/admin/maintenances",
    label: "Maintenances",
    active: route.name === "maintenances",
    count: activeMaintenancesCount.value,
    urgent: false,
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
  <AppLayout
    home-to="/admin"
    :links="snap.settings.site_links"
    :version="snap.version"
  >
    <template #nav>
      <nav aria-label="Primary" class="flex items-center gap-1">
        <RouterLink
          v-for="item in navItems"
          :key="item.to"
          class="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-[13px] font-medium whitespace-nowrap transition-colors"
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
              item.urgent
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
      <MutedBadge
        class="mr-1"
        :now="snap.now"
        :until="snap.settings.global_muted_until"
      />
      <UButton
        aria-label="Public status page"
        class="px-1.5 sm:px-2.5"
        color="neutral"
        icon="i-lucide-globe"
        size="sm"
        to="/"
        variant="ghost"
      >
        <span class="hidden sm:inline">Public</span>
      </UButton>
      <UButton
        aria-label="Check now"
        class="px-1.5 sm:px-2.5"
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
        aria-label="Settings"
        class="px-1.5 sm:px-2.5"
        :color="route.name === 'settings' ? 'primary' : 'neutral'"
        icon="i-lucide-sliders-horizontal"
        size="sm"
        to="/admin/settings"
        :variant="route.name === 'settings' ? 'soft' : 'ghost'"
      >
        <span class="hidden sm:inline">Settings</span>
      </UButton>
    </template>

    <template #actions>
      <UButton
        aria-label="Sign out"
        class="-mr-1.5 px-1.5 sm:mr-0 sm:px-2.5"
        color="neutral"
        icon="i-lucide-log-out"
        size="sm"
        variant="ghost"
        @click="onSignOut"
      >
        <span class="hidden sm:inline">Sign out</span>
      </UButton>
    </template>

    <StatusBanner
      v-if="snap.incidents.length > 0 && route.name !== 'incidents'"
      class="mb-6"
      :title="`${snap.incidents.length} ${snap.incidents.length === 1 ? 'active incident' : 'active incidents'}`"
      to="/admin/incidents"
      :tone="openIncidents > 0 ? 'fail' : 'warn'"
    >
      <span class="truncate text-xs text-muted">{{ incidentHeadline }}</span>
      <template #trailing>
        <span
          class="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-muted"
        >
          View incidents
          <UIcon class="size-3.5" name="i-lucide-arrow-right" />
        </span>
      </template>
    </StatusBanner>

    <RouterView />

    <IssuedTokenModal />
  </AppLayout>
</template>
