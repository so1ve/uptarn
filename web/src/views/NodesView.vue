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
import {
  collectGroups,
  groupItems,
  reorderNamedGroups,
  usePageTitle,
  usePersistedReorder,
  useSnapshot,
} from "../lib/index.ts";

const VIEW_MODES = [
  { value: "cards" as const, label: "Cards", icon: "i-lucide-layout-grid" },
  { value: "table" as const, label: "Table", icon: "i-lucide-list" },
];

usePageTitle("Nodes");

const snap = useSnapshot();
const nodesView = useStorage<"cards" | "table">("uptarn:nodes-view", "cards");
const nodeFilter = ref("");
const addNodeOpen = ref(false);

const filteredNodes = computed(() => {
  const q = nodeFilter.value.trim().toLowerCase();

  return q
    ? snap.value.nodes.filter((n) =>
        `${n.id} ${n.label} ${n.group ?? ""}`.toLowerCase().includes(q),
      )
    : snap.value.nodes;
});

const groupedNodes = computed(() =>
  groupItems(filteredNodes.value, (n) => n.group),
);
const existingGroups = computed(() => collectGroups(snap.value.nodes));
const namedGroupCount = computed(
  () => groupedNodes.value.filter((g) => g.isNamed).length,
);
const groupById = computed(
  () => new Map(snap.value.nodes.map((n) => [n.id, n.group])),
);

const canReorder = computed(
  () => nodeFilter.value.trim() === "" && snap.value.nodes.length > 1,
);

const {
  dragAttrs,
  groupDropAttrs,
  moveBy,
  commit: onReorderNodes,
} = usePersistedReorder(
  "nodes",
  () => groupedNodes.value.flatMap((g) => g.items.map((n) => n.id)),
  () =>
    nodesView.value === "cards"
      ? "ring-2 ring-primary/50"
      : "bg-elevated/80 ring-1 ring-primary/50 ring-inset",
  (id) => groupById.value.get(id) ?? null,
);

function moveGroup(index: number, delta: -1 | 1) {
  const next = reorderNamedGroups(
    groupedNodes.value,
    index,
    delta,
    (n) => n.id,
  );
  if (next) {
    onReorderNodes(next);
  }
}
</script>

<template>
  <div class="space-y-6">
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

    <div v-else class="space-y-6">
      <div
        v-for="(group, groupIdx) in groupedNodes"
        :key="group.key"
        :class="nodesView === 'cards' ? 'space-y-2.5' : 'space-y-2'"
      >
        <div
          v-if="group.label"
          class="flex items-center justify-between gap-2 transition-colors"
          v-bind="
            groupDropAttrs(
              group.key,
              group.isNamed ? group.label : null,
              group.items.map((n) => n.id),
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

        <div
          v-if="nodesView === 'cards'"
          class="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3"
        >
          <div
            v-for="node in group.items"
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
          :drag-attrs
          :nodes="group.items"
          :now="snap.now"
          :reorderable="canReorder"
          @move-down="(id) => moveBy(id, 1)"
          @move-up="(id) => moveBy(id, -1)"
        />
      </div>
    </div>

    <AddNodeModal v-model:open="addNodeOpen" :groups="existingGroups" />
  </div>
</template>
