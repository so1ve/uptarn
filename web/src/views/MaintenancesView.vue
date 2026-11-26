<script setup lang="ts">
import { computed, ref } from "vue";

import MaintenanceModal from "../components/modals/MaintenanceModal.vue";
import EmptyState from "../components/ui/EmptyState.vue";
import PageHeader from "../components/ui/PageHeader.vue";
import StatusDot from "../components/ui/StatusDot.vue";
import type { MaintenanceSummary, MaintenanceTarget } from "../lib/index.ts";
import {
  formatDuration,
  formatRemaining,
  formatTimestamp,
  usePageTitle,
  useSnapshot,
} from "../lib/index.ts";

usePageTitle("Maintenances");

const snap = useSnapshot();
const modalOpen = ref(false);
const editing = ref<MaintenanceSummary | null>(null);

const current = computed(() =>
  snap.value.maintenances
    .filter((m) => m.state !== "completed")
    .sort((a, b) => a.starts_at - b.starts_at),
);
const past = computed(() =>
  snap.value.maintenances.filter((m) => m.state === "completed"),
);

const sections = computed(() => [
  { key: "current", title: "Active & scheduled", items: current.value },
  ...(past.value.length > 0
    ? [{ key: "past", title: "Completed", items: past.value }]
    : []),
]);

function targetLabel(target: MaintenanceTarget): string {
  if (target.type === "monitor") {
    return (
      snap.value.monitors.find((m) => m.id === target.id)?.name ?? target.id
    );
  }

  return snap.value.nodes.find((n) => n.id === target.id)?.label ?? target.id;
}

function openModal(item: MaintenanceSummary | null) {
  editing.value = item;
  modalOpen.value = true;
}
</script>

<template>
  <div class="space-y-6">
    <PageHeader title="Maintenances">
      <UButton
        color="primary"
        icon="i-lucide-plus"
        size="xs"
        @click="openModal(null)"
      >
        Schedule maintenance
      </UButton>
    </PageHeader>

    <EmptyState v-if="snap.maintenances.length === 0">
      No maintenance windows scheduled.
    </EmptyState>

    <div v-else class="space-y-8">
      <section v-for="sec in sections" :key="sec.key" class="space-y-3">
        <div class="flex items-baseline gap-2">
          <h2 class="text-sm font-semibold">{{ sec.title }}</h2>
          <span class="text-xs text-dimmed tabular-nums">
            {{ sec.items.length }}
          </span>
        </div>

        <EmptyState v-if="sec.items.length === 0">
          No active or scheduled maintenances.
        </EmptyState>

        <ol v-else class="divide-y divide-default border-y border-default">
          <li
            v-for="m in sec.items"
            :key="m.id"
            class="space-y-2 py-4"
            :class="m.state === 'completed' ? 'opacity-65' : ''"
          >
            <div class="flex items-start justify-between gap-3">
              <div class="flex min-w-0 flex-wrap items-center gap-2">
                <StatusDot
                  :status="
                    m.state === 'active'
                      ? 'warn'
                      : m.state === 'upcoming'
                        ? 'pending'
                        : 'ok'
                  "
                />
                <span class="text-sm font-semibold">{{ m.title }}</span>
                <UBadge
                  :color="
                    m.state === 'active'
                      ? 'warning'
                      : m.state === 'upcoming'
                        ? 'neutral'
                        : 'success'
                  "
                  size="xs"
                  variant="subtle"
                >
                  {{
                    m.state === "active"
                      ? "In progress"
                      : m.state === "upcoming"
                        ? "Scheduled"
                        : "Completed"
                  }}
                </UBadge>
              </div>

              <div class="flex shrink-0 items-center gap-2">
                <span
                  class="inline-flex items-center gap-2.5 font-mono text-xs text-muted tabular-nums"
                >
                  <template v-if="m.state === 'active'">
                    Ends in {{ formatRemaining(m.ends_at, snap.now) }}
                  </template>
                  <template v-else>
                    <span>{{ formatTimestamp(m.starts_at, true) }}</span>
                    <span class="text-dimmed">
                      {{ formatDuration(m.ends_at - m.starts_at) }}
                    </span>
                  </template>
                </span>
                <UButton
                  aria-label="Edit maintenance"
                  color="neutral"
                  icon="i-lucide-pencil"
                  size="xs"
                  variant="ghost"
                  @click="openModal(m)"
                />
              </div>
            </div>

            <p
              v-if="m.body"
              class="pl-4 text-xs leading-relaxed whitespace-pre-line text-muted"
            >
              {{ m.body }}
            </p>

            <div class="flex flex-wrap items-center gap-1.5 pl-4">
              <UBadge
                v-if="m.targets.length === 0"
                color="neutral"
                size="xs"
                variant="subtle"
              >
                All targets
              </UBadge>
              <UBadge
                v-for="t in m.targets"
                v-else
                :key="`${t.type}:${t.id}`"
                color="neutral"
                size="xs"
                variant="subtle"
              >
                {{ targetLabel(t) }}
              </UBadge>
            </div>
          </li>
        </ol>
      </section>
    </div>

    <MaintenanceModal v-model:open="modalOpen" :maintenance="editing" />
  </div>
</template>
