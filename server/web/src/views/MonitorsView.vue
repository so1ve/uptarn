<script setup lang="ts">
import { computed, reactive, ref } from "vue";

import MonitorModal from "../components/modals/MonitorModal.vue";
import MonitorRow from "../components/monitors/MonitorRow.vue";
import EChart from "../components/ui/EChart.vue";
import EmptyState from "../components/ui/EmptyState.vue";
import PageHeader from "../components/ui/PageHeader.vue";
import type { MonitorSummary } from "../lib/index.ts";
import {
  buildMonitorLatencyOption,
  monitorLatencyStats,
  useAction,
  useReorder,
  useSnapshot,
  useUptarnStore,
} from "../lib/index.ts";

const snap = useSnapshot();
const { busy, run, mute } = useAction();
const { isDark, persistOrder } = useUptarnStore();

const monitorModalOpen = ref(false);
const editingMonitor = ref<MonitorSummary | null>(null);
const expandedIds = reactive(new Set<string>());

const rows = computed(() =>
  snap.value.monitors.map((mon) => ({
    mon,
    stats: monitorLatencyStats(mon),
    chartOption:
      expandedIds.has(mon.id) && mon.samples.length >= 2
        ? buildMonitorLatencyOption(mon, isDark.value)
        : null,
  })),
);

const canReorder = computed(() => snap.value.monitors.length > 1);

const { dragAttrs, moveBy } = useReorder(
  () => snap.value.monitors.map((m) => m.id),
  (ids) => {
    void run("reorder", "Failed to save monitor order", () =>
      persistOrder("monitors", ids),
    );
  },
);

function toggleExpand(id: string) {
  if (expandedIds.has(id)) {
    expandedIds.delete(id);
  } else {
    expandedIds.add(id);
  }
}

function openMonitorModal(mon: MonitorSummary | null) {
  if (mon?.managed_by_node_id) {
    return;
  }
  editingMonitor.value = mon;
  monitorModalOpen.value = true;
}

const onToggleMute = (mon: MonitorSummary) =>
  mute(
    mon.id,
    "monitor",
    mon.id,
    mon.name,
    mon.muted_until > snap.value.now ? 0 : 3600,
  );
</script>

<template>
  <div class="space-y-6">
    <PageHeader title="Monitors">
      <UButton
        color="primary"
        icon="i-lucide-plus"
        size="xs"
        @click="openMonitorModal(null)"
      >
        Add monitor
      </UButton>
    </PageHeader>

    <EmptyState v-if="rows.length === 0">No monitors yet.</EmptyState>

    <div v-else class="divide-y divide-default border-y border-default">
      <div
        v-for="{ mon, stats, chartOption } in rows"
        :key="mon.id"
        v-bind="dragAttrs(mon.id, canReorder)"
      >
        <MonitorRow
          :expanded="expandedIds.has(mon.id)"
          :monitor="mon"
          :now="snap.now"
          :reorderable="canReorder"
          @edit="openMonitorModal(mon)"
          @move-down="moveBy(mon.id, 1)"
          @move-up="moveBy(mon.id, -1)"
          @toggle="toggleExpand(mon.id)"
        />

        <div
          v-if="expandedIds.has(mon.id)"
          class="mb-4 ml-6 rounded-xl border border-default bg-surface p-4"
        >
          <div class="mb-3 flex flex-wrap items-center justify-between gap-3">
            <span class="font-mono text-xs text-muted tabular-nums">
              {{ stats ?? "" }}
            </span>
            <UButton
              color="neutral"
              :loading="busy === mon.id"
              size="xs"
              variant="soft"
              @click="onToggleMute(mon)"
            >
              {{ mon.muted_until > snap.now ? "Unmute" : "Mute 1h" }}
            </UButton>
          </div>

          <EChart v-if="chartOption" height="180px" :option="chartOption" />
          <p v-else class="py-4 text-center text-xs text-dimmed">
            No samples yet.
          </p>
        </div>
      </div>
    </div>

    <MonitorModal v-model:open="monitorModalOpen" :monitor="editingMonitor" />
  </div>
</template>
