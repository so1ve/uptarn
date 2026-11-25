<script setup lang="ts">
import { useStorage } from "@vueuse/core";
import { computed, ref } from "vue";

import AddNodeModal from "../components/modals/AddNodeModal.vue";
import NodeCard from "../components/nodes/NodeCard.vue";
import NodeTable from "../components/nodes/NodeTable.vue";
import DragHandle from "../components/ui/DragHandle.vue";
import EmptyState from "../components/ui/EmptyState.vue";
import PageHeader from "../components/ui/PageHeader.vue";
import SegmentedControl from "../components/ui/SegmentedControl.vue";
import StatusBanner from "../components/ui/StatusBanner.vue";
import {
  splitIncident,
  usePersistedReorder,
  useSnapshot,
} from "../lib/index.ts";

const VIEW_MODES = [
  { value: "cards" as const, label: "Cards", icon: "i-lucide-layout-grid" },
  { value: "table" as const, label: "Table", icon: "i-lucide-list" },
];

const snap = useSnapshot();
const nodesView = useStorage<"cards" | "table">("uptarn:nodes-view", "cards");
const nodeFilter = ref("");
const addNodeOpen = ref(false);

const openIncidents = computed(
  () => snap.value.incidents.filter((i) => i.state === "open").length,
);

const filteredNodes = computed(() => {
  const q = nodeFilter.value.trim().toLowerCase();

  return q
    ? snap.value.nodes.filter((n) =>
        `${n.id} ${n.label}`.toLowerCase().includes(q),
      )
    : snap.value.nodes;
});

const canReorder = computed(
  () => nodeFilter.value.trim() === "" && snap.value.nodes.length > 1,
);

const {
  dragAttrs,
  moveBy,
  commit: onReorderNodes,
} = usePersistedReorder(
  "nodes",
  () => snap.value.nodes.map((n) => n.id),
  "ring-2 ring-primary/50",
);

const incidentHeadline = computed(() => {
  const titles = snap.value.incidents
    .slice(0, 3)
    .map((inc) => splitIncident(inc).title)
    .join(", ");
  const extra = snap.value.incidents.length - 3;

  return extra > 0 ? `${titles} +${extra} more` : titles;
});
</script>

<template>
  <div class="space-y-6">
    <StatusBanner
      v-if="snap.incidents.length > 0"
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

    <PageHeader title="Nodes">
      <UInput
        v-if="snap.nodes.length > 6"
        v-model="nodeFilter"
        class="w-44"
        icon="i-lucide-search"
        placeholder="Filter…"
        size="xs"
      />
      <SegmentedControl
        v-if="snap.nodes.length > 0"
        v-model="nodesView"
        aria-label="Node layout"
        :options="VIEW_MODES"
      />
      <UButton
        color="primary"
        icon="i-lucide-plus"
        size="xs"
        @click="addNodeOpen = true"
      >
        Add node
      </UButton>
    </PageHeader>

    <EmptyState v-if="snap.nodes.length === 0">No nodes yet.</EmptyState>

    <EmptyState v-else-if="filteredNodes.length === 0">
      No matching nodes.
    </EmptyState>

    <div
      v-else-if="nodesView === 'cards'"
      class="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3"
    >
      <div
        v-for="node in filteredNodes"
        :key="node.id"
        class="group/card relative flex flex-col rounded-xl transition-opacity"
        v-bind="dragAttrs(node.id, canReorder)"
      >
        <DragHandle
          v-if="canReorder"
          class="absolute top-3.5 left-1.5 z-10 text-dimmed/50 opacity-0 transition-opacity group-hover/card:opacity-100 focus-visible:opacity-100"
          label="node"
          @move-down="moveBy(node.id, 1)"
          @move-up="moveBy(node.id, -1)"
        />
        <NodeCard class="flex-1" draggable="false" :node :now="snap.now" />
      </div>
    </div>

    <NodeTable
      v-else
      :nodes="filteredNodes"
      :now="snap.now"
      :reorderable="canReorder"
      @reorder="onReorderNodes"
    />

    <AddNodeModal v-model:open="addNodeOpen" />
  </div>
</template>
