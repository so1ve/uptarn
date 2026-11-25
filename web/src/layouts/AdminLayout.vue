<script setup lang="ts">
import { computed } from "vue";
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

const navItems = computed(() => [
  {
    to: "/admin/nodes",
    label: "Nodes",
    count: snap.value.nodes.length,
    urgent: false,
  },
  {
    to: "/admin/monitors",
    label: "Monitors",
    count: snap.value.monitors.length,
    urgent: false,
  },
  {
    to: "/admin/jobs",
    label: "Jobs",
    count: snap.value.jobs.length,
    urgent: false,
  },
  {
    to: "/admin/incidents",
    label: "Incidents",
    count: totalIncidents.value,
    urgent: totalIncidents.value > 0,
  },
  {
    to: "/admin/maintenances",
    label: "Maintenances",
    count: activeMaintenancesCount.value,
    urgent: false,
  },
]);

const isNavActive = (to: string) =>
  route.path === to || route.path.startsWith(`${to}/`);

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
    home-to="/admin/nodes"
    :links="snap.settings.site_links"
    :version="snap.version"
  >
    <template #nav>
      <nav aria-label="Primary" class="flex items-center gap-1">
        <RouterLink
          v-for="item in navItems"
          :key="item.to"
          class="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-[13px] font-medium whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:outline-primary"
          :class="
            isNavActive(item.to)
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
      <UTooltip text="Run monitor checks now">
        <button
          aria-label="Check now"
          class="inline-flex h-8 w-8 cursor-pointer items-center justify-center gap-1.5 rounded-md text-[13px] font-medium text-muted transition-colors hover:bg-elevated/70 hover:text-default focus-visible:outline-2 focus-visible:outline-primary disabled:pointer-events-none disabled:opacity-50 sm:w-auto sm:px-2.5"
          :disabled="busy === 'tick'"
          type="button"
          @click="onCheckNow"
        >
          <UIcon
            class="size-4 shrink-0"
            :class="busy === 'tick' ? 'animate-spin' : ''"
            name="i-lucide-refresh-cw"
          />
          <span class="hidden sm:inline">Check now</span>
        </button>
      </UTooltip>
      <UTooltip text="View public status page">
        <RouterLink
          aria-label="Public status page"
          class="inline-flex h-8 w-8 items-center justify-center gap-1.5 rounded-md text-[13px] font-medium text-muted transition-colors hover:bg-elevated/70 hover:text-default focus-visible:outline-2 focus-visible:outline-primary sm:w-auto sm:px-2.5"
          to="/"
        >
          <UIcon class="size-4 shrink-0" name="i-lucide-globe" />
          <span class="hidden sm:inline">Status</span>
        </RouterLink>
      </UTooltip>
      <span
        aria-hidden="true"
        class="mx-1.5 h-4 w-px bg-zinc-300 dark:bg-zinc-700"
      />
      <UTooltip text="Settings">
        <RouterLink
          aria-label="Settings"
          class="inline-flex size-8 items-center justify-center rounded-md transition-colors focus-visible:outline-2 focus-visible:outline-primary"
          :class="
            isNavActive('/admin/settings')
              ? 'bg-elevated text-highlighted'
              : 'text-muted hover:bg-elevated/70 hover:text-default'
          "
          to="/admin/settings"
        >
          <UIcon class="size-4" name="i-lucide-settings" />
        </RouterLink>
      </UTooltip>
    </template>

    <template #actions>
      <UTooltip text="Sign out">
        <button
          aria-label="Sign out"
          class="-mr-1.5 inline-flex size-8 cursor-pointer items-center justify-center rounded-md text-muted transition-colors hover:bg-elevated/70 hover:text-default focus-visible:outline-2 focus-visible:outline-primary"
          type="button"
          @click="onSignOut"
        >
          <UIcon class="size-4" name="i-lucide-log-out" />
        </button>
      </UTooltip>
    </template>

    <StatusBanner
      v-if="snap.incidents.length > 0 && !route.meta.hideIncidentBanner"
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
