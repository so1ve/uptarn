<script setup lang="ts">
import { computed, reactive, ref } from "vue";

import MonitorModal from "../components/modals/MonitorModal.vue";
import MonitorRow from "../components/monitors/MonitorRow.vue";
import ChartCard from "../components/ui/ChartCard.vue";
import EmptyState from "../components/ui/EmptyState.vue";
import MuteButton from "../components/ui/MuteButton.vue";
import PageHeader from "../components/ui/PageHeader.vue";
import SegmentedControl from "../components/ui/SegmentedControl.vue";
import type { MonitorSummary } from "../lib/index.ts";
import {
  MONITOR_WINDOWS,
  buildMonitorLatencyOption,
  monitorLatencyStats,
  useMonitorWindow,
  usePersistedReorder,
  useSnapshot,
  useUptarnStore,
} from "../lib/index.ts";

const snap = useSnapshot();
const { isDark } = useUptarnStore();

const monitorModalOpen = ref(false);
const editingMonitor = ref<MonitorSummary | null>(null);
const expandedIds = reactive(new Set<string>());
const monitorWindow = useMonitorWindow();

const rows = computed(() =>
  snap.value.monitors.map((mon) => ({
    mon,
    stats: monitorLatencyStats(mon, monitorWindow.value, snap.value.now),
    chartOption: expandedIds.has(mon.id)
      ? buildMonitorLatencyOption(
          mon,
          isDark.value,
          monitorWindow.value,
          snap.value.now,
        )
      : null,
  })),
);

const canReorder = computed(() => snap.value.monitors.length > 1);
const { dragAttrs, moveBy } = usePersistedReorder("monitors", () =>
  snap.value.monitors.map((m) => m.id),
);

function toggleExpand(id: string) {
  if (expandedIds.has(id)) {
    expandedIds.delete(id);
  } else {
    expandedIds.add(id);
  }
}

function openMonitorModal(mon: MonitorSummary | null) {
  editingMonitor.value = mon;
  monitorModalOpen.value = true;
}
</script>

<template>
  <div class="space-y-6">
    <PageHeader title="Monitors">
      <SegmentedControl
        v-if="rows.length > 0"
        v-model="monitorWindow"
        aria-label="Uptime window"
        mono
        :options="MONITOR_WINDOWS"
      />
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
          :window="monitorWindow"
          @edit="openMonitorModal(mon)"
          @move-down="moveBy(mon.id, 1)"
          @move-up="moveBy(mon.id, -1)"
          @toggle="toggleExpand(mon.id)"
        />

        <ChartCard
          v-if="expandedIds.has(mon.id)"
          class="mb-4 sm:ml-6"
          compact
          :empty-text="
            mon.samples.length > 0 && mon.probe.type === 'exec'
              ? 'No latency data for command checks.'
              : 'No samples yet.'
          "
          height="180px"
          :option="chartOption"
        >
          <template #title>
            <span class="font-mono text-xs text-muted tabular-nums">
              {{ stats ?? "" }}
            </span>
          </template>
          <template #meta>
            <MuteButton
              :label="mon.name"
              :muted-until="mon.muted_until"
              :now="snap.now"
              :target-id="mon.id"
              target-type="monitor"
              variant="soft"
            />
          </template>
        </ChartCard>
      </div>
    </div>

    <MonitorModal v-model:open="monitorModalOpen" :monitor="editingMonitor" />
  </div>
</template>
