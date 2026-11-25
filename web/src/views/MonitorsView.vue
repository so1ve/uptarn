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
  collectGroups,
  groupItems,
  monitorLatencyStats,
  reorderNamedGroups,
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
    chartOption:
      mon.probe.type !== "exec" && expandedIds.has(mon.id)
        ? buildMonitorLatencyOption(
            mon,
            isDark.value,
            monitorWindow.value,
            snap.value.now,
          )
        : null,
  })),
);

const groupedRows = computed(() =>
  groupItems(rows.value, (row) => row.mon.group),
);
const existingGroups = computed(() => collectGroups(snap.value.monitors));
const namedGroupCount = computed(
  () => groupedRows.value.filter((g) => g.isNamed).length,
);
const groupById = computed(
  () => new Map(snap.value.monitors.map((m) => [m.id, m.group])),
);

const canReorder = computed(() => snap.value.monitors.length > 1);
const {
  dragAttrs,
  moveBy,
  commit: commitOrder,
} = usePersistedReorder(
  "monitors",
  () => groupedRows.value.flatMap((g) => g.items.map((r) => r.mon.id)),
  undefined,
  (id) => groupById.value.get(id) ?? null,
);

function moveGroup(index: number, delta: -1 | 1) {
  const next = reorderNamedGroups(
    groupedRows.value,
    index,
    delta,
    (r) => r.mon.id,
  );
  if (next) {
    commitOrder(next);
  }
}

function toggleExpand(mon: MonitorSummary) {
  if (mon.probe.type === "exec") {
    return;
  }
  if (expandedIds.has(mon.id)) {
    expandedIds.delete(mon.id);
  } else {
    expandedIds.add(mon.id);
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

    <div v-else class="space-y-6">
      <div
        v-for="(group, groupIdx) in groupedRows"
        :key="group.key"
        class="space-y-2"
      >
        <div v-if="group.label" class="flex items-center justify-between gap-2">
          <h3 class="text-xs font-medium text-muted">{{ group.label }}</h3>
          <div
            v-if="canReorder && group.isNamed && namedGroupCount > 1"
            class="flex items-center gap-0.5"
          >
            <UButton
              :aria-label="`Move ${group.label} up`"
              color="neutral"
              :disabled="groupIdx === 0"
              icon="i-lucide-chevron-up"
              size="xs"
              variant="ghost"
              @click="moveGroup(groupIdx, -1)"
            />
            <UButton
              :aria-label="`Move ${group.label} down`"
              color="neutral"
              :disabled="groupIdx >= namedGroupCount - 1"
              icon="i-lucide-chevron-down"
              size="xs"
              variant="ghost"
              @click="moveGroup(groupIdx, 1)"
            />
          </div>
        </div>

        <div class="divide-y divide-default border-y border-default">
          <div
            v-for="{ mon, stats, chartOption } in group.items"
            :key="mon.id"
            v-bind="dragAttrs(mon.id, canReorder && group.items.length > 1)"
          >
            <MonitorRow
              :expanded="expandedIds.has(mon.id)"
              :monitor="mon"
              :now="snap.now"
              :reorderable="canReorder && group.items.length > 1"
              :window="monitorWindow"
              @edit="openMonitorModal(mon)"
              @move-down="moveBy(mon.id, 1)"
              @move-up="moveBy(mon.id, -1)"
              @toggle="toggleExpand(mon)"
            />

            <ChartCard
              v-if="mon.probe.type !== 'exec' && expandedIds.has(mon.id)"
              class="mb-4 sm:ml-6"
              compact
              empty-text="No samples yet."
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
      </div>
    </div>

    <MonitorModal
      v-model:open="monitorModalOpen"
      :groups="existingGroups"
      :monitor="editingMonitor"
      :now="snap.now"
    />
  </div>
</template>
