<script setup lang="ts">
import { useStorage } from "@vueuse/core";
import { computed, ref } from "vue";

import AddNodeModal from "../components/modals/AddNodeModal.vue";
import NodeCard from "../components/nodes/NodeCard.vue";
import NodeTable from "../components/nodes/NodeTable.vue";
import DragHandle from "../components/ui/DragHandle.vue";
import EmptyState from "../components/ui/EmptyState.vue";
import PageHeader from "../components/ui/PageHeader.vue";
import StatusDot from "../components/ui/StatusDot.vue";
import {
  splitIncident,
  useAction,
  useReorder,
  useSnapshot,
  useUptarnStore,
} from "../lib/index.ts";

const VIEW_MODES = [
  { id: "cards", label: "Cards", icon: "i-lucide-layout-grid" },
  { id: "table", label: "Table", icon: "i-lucide-list" },
] as const;

const snap = useSnapshot();
const { run } = useAction();
const { persistOrder } = useUptarnStore();

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

function onReorderNodes(ids: string[]) {
  void run("reorder-nodes", "Failed to save node order", () =>
    persistOrder("nodes", ids),
  );
}

const { dragAttrs, moveBy } = useReorder(
  () => snap.value.nodes.map((n) => n.id),
  onReorderNodes,
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
    <RouterLink
      v-if="snap.incidents.length > 0"
      class="flex flex-wrap items-center justify-between gap-3 rounded-xl px-4 py-2.5 text-sm transition-opacity hover:opacity-90"
      :class="openIncidents > 0 ? 'bg-red-500/10' : 'bg-amber-500/10'"
      to="/admin/incidents"
    >
      <div class="flex min-w-0 items-center gap-2.5">
        <StatusDot :status="openIncidents > 0 ? 'fail' : 'warn'" />
        <span
          class="font-semibold whitespace-nowrap"
          :class="
            openIncidents > 0
              ? 'text-red-600 dark:text-red-400'
              : 'text-amber-600 dark:text-amber-400'
          "
        >
          {{ snap.incidents.length }}
          {{
            snap.incidents.length === 1 ? "active incident" : "active incidents"
          }}
        </span>
        <span class="truncate text-xs text-muted">{{ incidentHeadline }}</span>
      </div>
      <span
        class="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-muted"
      >
        View incidents
        <UIcon class="size-3.5" name="i-lucide-arrow-right" />
      </span>
    </RouterLink>

    <PageHeader title="Nodes">
      <UInput
        v-if="snap.nodes.length > 6"
        v-model="nodeFilter"
        class="w-44"
        icon="i-lucide-search"
        placeholder="Filter…"
        size="xs"
      />
      <div
        v-if="snap.nodes.length > 0"
        aria-label="Node layout"
        class="inline-flex items-center rounded-lg bg-muted p-0.5"
        role="group"
      >
        <UButton
          v-for="m in VIEW_MODES"
          :key="m.id"
          color="neutral"
          :icon="m.icon"
          size="xs"
          :variant="nodesView === m.id ? 'solid' : 'ghost'"
          @click="nodesView = m.id"
        >
          {{ m.label }}
        </UButton>
      </div>
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
