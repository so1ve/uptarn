<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import { useRouter } from "vue-router";

import MaintenanceNotice from "../components/incidents/MaintenanceNotice.vue";
import PublicIncidentsSection from "../components/incidents/PublicIncidentsSection.vue";
import SignInForm from "../components/modals/SignInForm.vue";
import MonitorItem from "../components/monitors/MonitorItem.vue";
import EmptyState from "../components/ui/EmptyState.vue";
import SegmentedControl from "../components/ui/SegmentedControl.vue";
import SparkMetric from "../components/ui/SparkMetric.vue";
import StatusBanner from "../components/ui/StatusBanner.vue";
import StatusDot from "../components/ui/StatusDot.vue";
import UsageBar from "../components/ui/UsageBar.vue";
import AppLayout from "../layouts/AppLayout.vue";
import type { PublicStatusSnapshot } from "../lib/index.ts";
import {
  MONITOR_WINDOWS,
  formatDuration,
  groupItems,
  hostOf,
  pickSparkHistory,
  usageTextClass,
  useLiveRefresh,
  useMonitorWindow,
  usePageTitle,
  useUptarnStore,
} from "../lib/index.ts";

const props = defineProps<{
  status: PublicStatusSnapshot;
  adminPreview?: boolean;
}>();

const router = useRouter();
const { loadState, publicLiveHistory } = useUptarnStore();
const signInOpen = ref(false);
const monitorWindow = useMonitorWindow();
const expandedKeys = reactive(new Set<string>());

function toggleExpand(key: string) {
  if (expandedKeys.has(key)) {
    expandedKeys.delete(key);
  } else {
    expandedKeys.add(key);
  }
}

usePageTitle("Status");
useLiveRefresh("public");

const hasContent = computed(
  () => props.status.monitors.length > 0 || props.status.nodes.length > 0,
);
const groupedMonitors = computed(() =>
  groupItems(props.status.monitors, (m) => m.group),
);
const groupedNodes = computed(() =>
  groupItems(props.status.nodes, (n) => n.group),
);
const ongoingIncidents = computed(() =>
  props.status.incidents.filter((i) => i.state === "open"),
);
const resolvedIncidents = computed(() =>
  props.status.incidents.filter((i) => i.state === "resolved"),
);
const activeReports = computed(() =>
  (props.status.incident_reports ?? []).filter(
    (r) => r.resolved_at === null && r.status !== "resolved",
  ),
);
const resolvedReports = computed(() =>
  (props.status.incident_reports ?? []).filter(
    (r) => r.resolved_at !== null || r.status === "resolved",
  ),
);
const incidentsByMonitorKey = computed(() => {
  const map = new Map<string, typeof props.status.incidents>();
  for (const inc of props.status.incidents) {
    if (inc.target_type !== "monitor") {
      continue;
    }
    const list = map.get(inc.target_key);
    if (list) {
      list.push(inc);
    } else {
      map.set(inc.target_key, [inc]);
    }
  }

  return map;
});

const banner = computed(() => {
  const failing =
    props.status.monitors.filter((m) => m.enabled && m.last_status === "fail")
      .length +
    props.status.nodes.filter(
      (n) => n.overall_status === "fail" || n.overall_status === "offline",
    ).length;
  if (failing > 0 || activeReports.value.some((r) => r.impact === "major")) {
    return {
      tone: "fail" as const,
      text:
        failing > 0
          ? failing === 1
            ? "1 service experiencing issues"
            : `${failing} services experiencing issues`
          : "Active service disruption",
    };
  }
  if (
    activeReports.value.length > 0 ||
    props.status.nodes.some((n) => n.overall_status === "warn")
  ) {
    return { tone: "warn" as const, text: "Partial system degradation" };
  }

  return { tone: "ok" as const, text: "All systems operational" };
});

async function onSignedIn() {
  signInOpen.value = false;
  await loadState();
  await router.push("/admin/nodes");
}
</script>

<template>
  <AppLayout
    :host="hostOf(status.public_base_url)"
    :links="status.site_links"
    :title="status.site_title"
    :version="status.version"
  >
    <template #actions>
      <RouterLink
        v-if="adminPreview"
        class="ml-1 inline-flex h-8 items-center gap-1.5 rounded-md bg-elevated px-3 text-[13px] font-medium text-highlighted transition-colors hover:bg-accented focus-visible:outline-2 focus-visible:outline-primary"
        to="/admin/nodes"
      >
        <UIcon class="size-3.5" name="i-lucide-arrow-left" />
        <span>Dashboard</span>
      </RouterLink>
      <button
        v-else
        class="ml-1 inline-flex h-8 cursor-pointer items-center rounded-md bg-elevated px-3 text-[13px] font-medium text-highlighted transition-colors hover:bg-accented focus-visible:outline-2 focus-visible:outline-primary"
        type="button"
        @click="signInOpen = true"
      >
        Sign in
      </button>
    </template>

    <EmptyState v-if="!hasContent">
      <p class="font-medium text-default">Nothing is public yet.</p>
      <p class="mt-1 text-xs text-muted">
        Mark a node or monitor as public to show it here. Visitors see the
        sign-in screen until then.
      </p>
    </EmptyState>

    <div v-else class="space-y-8">
      <StatusBanner :title="banner.text" :tone="banner.tone" />

      <MaintenanceNotice
        :maintenances="status.maintenances"
        :now="status.now"
      />

      <PublicIncidentsSection
        highlight
        :incidents="ongoingIncidents"
        :now="status.now"
        :reports="activeReports"
        title="Active incidents"
      />

      <section v-if="status.monitors.length > 0" class="space-y-4">
        <div class="flex flex-wrap items-center justify-between gap-3">
          <h2 class="text-base font-semibold tracking-tight">Services</h2>
          <SegmentedControl
            v-model="monitorWindow"
            aria-label="Uptime window"
            mono
            :options="MONITOR_WINDOWS"
          />
        </div>
        <div class="space-y-6">
          <div
            v-for="group in groupedMonitors"
            :key="group.key"
            class="space-y-2"
          >
            <h3 v-if="group.label" class="text-xs font-medium text-muted">
              {{ group.label }}
            </h3>
            <div class="divide-y divide-default border-y border-default">
              <div v-for="mon in group.items" :key="mon.key">
                <MonitorItem
                  :expanded="expandedKeys.has(mon.key)"
                  :incidents="incidentsByMonitorKey.get(mon.key)"
                  :monitor="mon"
                  :now="status.now"
                  :window="monitorWindow"
                  @toggle="toggleExpand(mon.key)"
                />
              </div>
            </div>
          </div>
        </div>
      </section>

      <section v-if="status.nodes.length > 0" class="space-y-4">
        <h2 class="text-base font-semibold tracking-tight">Nodes</h2>
        <div class="space-y-6">
          <div
            v-for="group in groupedNodes"
            :key="group.key"
            class="space-y-2.5"
          >
            <h3 v-if="group.label" class="text-xs font-medium text-muted">
              {{ group.label }}
            </h3>
            <div class="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
              <div
                v-for="node in group.items"
                :key="node.key"
                class="flex flex-col justify-between gap-4 rounded-xl border border-default bg-surface px-5 py-4"
              >
                <div class="flex items-center justify-between gap-3">
                  <div class="flex min-w-0 items-center gap-2">
                    <StatusDot :status="node.overall_status" />
                    <span class="truncate text-[14.5px] font-semibold">
                      {{ node.label }}
                    </span>
                  </div>
                  <span
                    v-if="
                      node.overall_status !== 'offline' &&
                      node.overall_status !== 'pending' &&
                      node.uptime_secs !== null
                    "
                    class="shrink-0 font-mono text-xs text-muted tabular-nums"
                  >
                    Up {{ formatDuration(node.uptime_secs) }}
                  </span>
                  <span
                    v-else-if="node.overall_status === 'offline'"
                    class="shrink-0 font-mono text-xs text-red-500 dark:text-red-400"
                  >
                    Offline
                  </span>
                </div>

                <div
                  class="space-y-3"
                  :class="node.overall_status === 'offline' ? 'opacity-50' : ''"
                >
                  <div
                    v-if="node.cpu_pct !== null || node.mem_pct !== null"
                    class="grid gap-5"
                    :class="
                      node.cpu_pct !== null && node.mem_pct !== null
                        ? 'grid-cols-2'
                        : 'grid-cols-1'
                    "
                  >
                    <SparkMetric
                      v-if="node.cpu_pct !== null"
                      :history="
                        pickSparkHistory(
                          publicLiveHistory[node.key]?._cpu,
                          node.cpu_history,
                        )
                      "
                      kind="cpu"
                      :pct="node.cpu_pct"
                    />
                    <SparkMetric
                      v-if="node.mem_pct !== null"
                      :history="
                        pickSparkHistory(
                          publicLiveHistory[node.key]?._mem,
                          node.mem_history,
                        )
                      "
                      kind="memory"
                      :pct="node.mem_pct"
                    />
                  </div>

                  <div v-if="node.storage_pct !== null" class="space-y-1.5">
                    <div
                      class="flex items-baseline justify-between gap-2 font-mono text-xs tabular-nums"
                    >
                      <span class="font-sans text-muted">Storage</span>
                      <span :class="usageTextClass(node.storage_pct, 85, 92)">
                        {{ Math.round(node.storage_pct) }}%
                      </span>
                    </div>
                    <UsageBar :pct="node.storage_pct" />
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <PublicIncidentsSection
        :incidents="resolvedIncidents"
        :now="status.now"
        :reports="resolvedReports"
        title="Recent incidents"
      />
    </div>

    <UModal
      v-if="!adminPreview"
      v-model:open="signInOpen"
      title="Sign in"
      :ui="{ content: 'max-w-sm' }"
    >
      <template #body>
        <SignInForm :auth="status.auth" @authenticated="onSignedIn" />
      </template>
    </UModal>
  </AppLayout>
</template>
