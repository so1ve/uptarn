<script setup lang="ts">
import { computed, reactive, ref } from "vue";

import MonitorModal from "../components/modals/MonitorModal.vue";
import MonitorItem from "../components/monitors/MonitorItem.vue";
import EmptyState from "../components/ui/EmptyState.vue";
import PageHeader from "../components/ui/PageHeader.vue";
import SegmentedControl from "../components/ui/SegmentedControl.vue";
import type { MonitorSummary } from "../lib/index.ts";
import {
  MONITOR_WINDOWS,
  collectGroups,
  groupItems,
  reorderNamedGroups,
  useMonitorWindow,
  usePageTitle,
  usePersistedReorder,
  useSnapshot,
} from "../lib/index.ts";

usePageTitle("Monitors");

const snap = useSnapshot();

const monitorModalOpen = ref(false);
const editingMonitor = ref<MonitorSummary | null>(null);
const expandedIds = reactive(new Set<string>());
const monitorWindow = useMonitorWindow();

const groupedMonitors = computed(() =>
  groupItems(snap.value.monitors, (mon) => mon.group),
);
const existingGroups = computed(() => collectGroups(snap.value.monitors));
const namedGroupCount = computed(
  () => groupedMonitors.value.filter((g) => g.isNamed).length,
);
const groupById = computed(
  () => new Map(snap.value.monitors.map((m) => [m.id, m.group])),
);

const canReorder = computed(() => snap.value.monitors.length > 1);
const {
  dragAttrs,
  groupDropAttrs,
  moveBy,
  commit: commitOrder,
} = usePersistedReorder(
  "monitors",
  () => groupedMonitors.value.flatMap((g) => g.items.map((m) => m.id)),
  undefined,
  (id) => groupById.value.get(id) ?? null,
);

function moveGroup(index: number, delta: -1 | 1) {
  const next = reorderNamedGroups(
    groupedMonitors.value,
    index,
    delta,
    (m) => m.id,
  );
  if (next) {
    commitOrder(next);
  }
}

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
        v-if="snap.monitors.length > 0"
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

    <EmptyState v-if="snap.monitors.length === 0">No monitors yet.</EmptyState>

    <div v-else class="space-y-6">
      <div
        v-for="(group, groupIdx) in groupedMonitors"
        :key="group.key"
        class="space-y-2"
      >
        <div
          v-if="group.label"
          class="flex items-center justify-between gap-2 transition-colors"
          v-bind="
            groupDropAttrs(
              group.key,
              group.isNamed ? group.label : null,
              group.items.map((m) => m.id),
              canReorder,
            )
          "
        >
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
            v-for="mon in group.items"
            :key="mon.id"
            v-bind="dragAttrs(mon.id, canReorder)"
          >
            <MonitorItem
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
