<script setup lang="ts">
import { useStorage } from "@vueuse/core";
import { computed, ref } from "vue";

import AddNodeModal from "../components/modals/AddNodeModal.vue";
import NodeCard from "../components/nodes/NodeCard.vue";
import NodeTable from "../components/nodes/NodeTable.vue";
import EmptyState from "../components/ui/EmptyState.vue";
import PageHeader from "../components/ui/PageHeader.vue";
import StatusDot from "../components/ui/StatusDot.vue";
import { splitIncident, useSnapshot } from "../lib/index.ts";

const snap = useSnapshot();

const nodesView = useStorage<"cards" | "table">("uptarn:nodes-view", "cards");
const nodeFilter = ref("");
const addNodeOpen = ref(false);

const openIssues = computed(
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

const incidentHeadline = computed(() =>
  snap.value.incidents
    .slice(0, 3)
    .map((inc) => splitIncident(inc).title)
    .join(", "),
);
</script>

<template>
  <div class="space-y-6">
    <RouterLink
      v-if="snap.incidents.length > 0"
      class="flex flex-wrap items-center justify-between gap-3 rounded-xl px-4 py-2.5 text-sm transition-opacity hover:opacity-90"
      :class="openIssues > 0 ? 'bg-red-500/10' : 'bg-amber-500/10'"
      to="/alerts"
    >
      <div class="flex min-w-0 items-center gap-2.5">
        <StatusDot :status="openIssues > 0 ? 'fail' : 'warn'" />
        <span
          class="font-semibold whitespace-nowrap"
          :class="
            openIssues > 0
              ? 'text-red-600 dark:text-red-400'
              : 'text-amber-600 dark:text-amber-400'
          "
        >
          {{ snap.incidents.length }}
          {{ snap.incidents.length === 1 ? "active issue" : "active issues" }}
        </span>
        <span class="truncate text-xs text-muted">
          {{
            `${incidentHeadline}${snap.incidents.length > 3 ? ` +${snap.incidents.length - 3} more` : ""}`
          }}
        </span>
      </div>
      <span
        class="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-muted"
      >
        View alerts
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
          color="neutral"
          icon="i-lucide-layout-grid"
          size="xs"
          :variant="nodesView === 'cards' ? 'solid' : 'ghost'"
          @click="nodesView = 'cards'"
        >
          Cards
        </UButton>
        <UButton
          color="neutral"
          icon="i-lucide-list"
          size="xs"
          :variant="nodesView === 'table' ? 'solid' : 'ghost'"
          @click="nodesView = 'table'"
        >
          Table
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
      <NodeCard
        v-for="node in filteredNodes"
        :key="node.id"
        :node
        :now="snap.now"
      />
    </div>

    <NodeTable v-else :nodes="filteredNodes" :now="snap.now" />

    <AddNodeModal v-model:open="addNodeOpen" />
  </div>
</template>
