<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";

import NodeChartsGrid from "../components/nodes/NodeChartsGrid.vue";
import NodeTelemetryPanel from "../components/nodes/NodeTelemetryPanel.vue";
import ConfirmPopover from "../components/ui/ConfirmPopover.vue";
import MutedBadge from "../components/ui/MutedBadge.vue";
import StatusDot from "../components/ui/StatusDot.vue";
import {
  apiFetch,
  buildProbeCharts,
  collectGroups,
  formatAge,
  formatBps,
  formatDuration,
  formatUsage,
  memPercent,
  statusTextClass,
  summarizeDisk,
  useAction,
  useNodeHistory,
  useSnapshot,
  useUptarnStore,
} from "../lib/index.ts";

const MUTE_OPTIONS = [
  { label: "Mute 1h", secs: 3600 },
  { label: "Mute 1d", secs: 86_400 },
] as const;

const route = useRoute();
const router = useRouter();
const snap = useSnapshot();
const { busy, run, mute } = useAction();
const { isDark, showIssuedToken } = useUptarnStore();

const nodeId = computed(() => String(route.params.id ?? ""));
const node = computed(
  () => snap.value.nodes.find((n) => n.id === nodeId.value) ?? null,
);
const isMuted = computed(
  () => node.value !== null && node.value.muted_until > snap.value.now,
);
const memPct = computed(() =>
  node.value ? memPercent(node.value.system) : null,
);
const swapUsage = computed(() => {
  const sys = node.value?.system;

  return sys?.swap_total_bytes && sys.swap_used_bytes !== undefined
    ? formatUsage(sys.swap_used_bytes, sys.swap_total_bytes)
    : null;
});
const disk = computed(() =>
  node.value
    ? summarizeDisk(node.value.mounts, node.value.primary_mount)
    : null,
);

const {
  windowSecs,
  loadingWindow,
  history: activeHistory,
} = useNodeHistory(nodeId, node);

const probeCharts = computed(() =>
  node.value
    ? buildProbeCharts(
        node.value,
        isDark.value,
        activeHistory.value,
        windowSecs.value > 86_400,
      )
    : [],
);

const scalarSeries = computed(() => {
  if (!node.value) {
    return [];
  }
  const charted = new Set(probeCharts.value.map((p) => p.series.key));

  return node.value.series.filter((s) => !charted.has(s.key));
});

const nodeUrl = (suffix = "") =>
  `/api/v1/admin/nodes/${encodeURIComponent(node.value!.id)}${suffix}`;

const groupPopoverOpen = ref(false);
const groupDraft = ref("");
const existingGroups = computed(() => collectGroups(snap.value.nodes));

watch(groupPopoverOpen, (isOpen) => {
  if (isOpen) {
    groupDraft.value = node.value?.group ?? "";
  }
});

async function onSaveGroup(raw: string | null) {
  const n = node.value;
  if (!n) {
    return;
  }
  const next = raw?.trim() || null;
  if (next === n.group) {
    groupPopoverOpen.value = false;

    return;
  }
  const ok = await run(
    "group",
    "Failed to update group",
    async () => {
      await apiFetch(nodeUrl(), "PATCH", { group: next });

      return next ? `Group set to ${next}` : "Removed from group";
    },
    true,
  );
  if (ok) {
    groupPopoverOpen.value = false;
  }
}

const onMute = (secs: number) =>
  node.value &&
  mute(`mute:${secs}`, "node", node.value.id, node.value.label, secs);

const onTogglePublic = () =>
  node.value &&
  run(
    "public",
    "Failed to update visibility",
    async () => {
      const next = !node.value!.is_public;
      await apiFetch(nodeUrl(), "PATCH", { is_public: next });

      return next ? "Shown on status page" : "Hidden from status page";
    },
    true,
  );

function onSelectPrimaryMount(mountPath: string | null) {
  const n = node.value;
  if (!n || n.primary_mount === mountPath) {
    return;
  }
  const label =
    mountPath === null
      ? "Total"
      : (n.mounts.find((m) => m.path === mountPath)?.label ?? mountPath);
  void run(
    "disk",
    "Failed to update disk summary",
    async () => {
      await apiFetch(nodeUrl(), "PATCH", { primary_mount: mountPath });

      return `Disk summary set to ${label}`;
    },
    true,
  );
}

const diskMenuItems = computed(() => {
  const n = node.value;
  if (!n || n.mounts.length <= 1) {
    return [];
  }

  return [
    [
      {
        label: "Total (all mounts)",
        icon: n.primary_mount === null ? "i-lucide-check" : undefined,
        onSelect: () => onSelectPrimaryMount(null),
      },
    ],
    n.mounts.map((m) => ({
      label: m.label ?? m.path,
      icon: n.primary_mount === m.path ? "i-lucide-check" : undefined,
      onSelect: () => onSelectPrimaryMount(m.path),
    })),
  ];
});

const onRotateToken = () =>
  node.value &&
  run("rotate", "Token rotation failed", async () => {
    showIssuedToken(
      await apiFetch<{ id: string; token: string }>(
        nodeUrl("/rotate-token"),
        "POST",
      ),
    );
  });

async function onDelete() {
  const n = node.value;
  if (!n) {
    return;
  }
  const ok = await run(
    "delete",
    "Delete failed",
    async () => {
      await apiFetch(nodeUrl(), "DELETE");

      return `Deleted ${n.label}`;
    },
    true,
  );
  if (ok) {
    await router.push("/admin");
  }
}
</script>

<template>
  <div v-if="!node" class="space-y-4 py-12 text-center">
    <p class="text-sm text-muted">Node "{{ nodeId }}" was not found.</p>
    <UButton color="neutral" to="/admin" variant="soft">Back to nodes</UButton>
  </div>

  <div v-else class="space-y-8">
    <div class="space-y-3">
      <RouterLink
        class="inline-flex items-center gap-1.5 text-xs font-medium text-muted transition-colors hover:text-default"
        to="/admin"
      >
        <UIcon class="size-3.5" name="i-lucide-arrow-left" />
        Nodes
      </RouterLink>

      <div class="flex flex-wrap items-start justify-between gap-4">
        <div class="space-y-1">
          <div class="flex flex-wrap items-center gap-2.5">
            <StatusDot size-class="size-2.5" :status="node.overall_status" />
            <h1 class="text-2xl font-semibold tracking-tight">
              {{ node.label }}
            </h1>
            <span
              v-if="node.label.toLowerCase() !== node.id.toLowerCase()"
              class="font-mono text-sm text-dimmed"
            >
              {{ node.id }}
            </span>
            <UBadge
              v-if="!node.is_public"
              color="neutral"
              size="xs"
              variant="subtle"
            >
              Private
            </UBadge>
            <MutedBadge :now="snap.now" :until="node.muted_until" />
          </div>
          <div
            class="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-xs text-muted tabular-nums"
          >
            <span v-if="node.system">
              Up {{ formatDuration(node.system.uptime_secs) }}
            </span>
            <span
              :class="
                node.overall_status === 'offline'
                  ? 'text-red-500 dark:text-red-400'
                  : ''
              "
            >
              Seen {{ formatAge(node.last_seen_at, snap.now) }}
            </span>
            <span v-if="node.agent_version">
              Agent {{ node.agent_version }}
            </span>
          </div>
        </div>

        <div class="flex flex-wrap items-center gap-2">
          <UPopover v-model:open="groupPopoverOpen">
            <UButton
              color="neutral"
              icon="i-lucide-folder"
              :loading="busy === 'group'"
              size="xs"
              trailing-icon="i-lucide-chevron-down"
              variant="soft"
            >
              <span class="max-w-36 truncate">{{ node.group ?? "Group" }}</span>
            </UButton>
            <template #content>
              <div class="w-64 space-y-2.5 p-3">
                <form
                  class="flex items-center gap-1.5"
                  @submit.prevent="onSaveGroup(groupDraft)"
                >
                  <UInput
                    v-model="groupDraft"
                    aria-label="Group name"
                    class="flex-1"
                    :maxlength="40"
                    placeholder="Group name"
                    size="xs"
                  />
                  <UButton
                    color="primary"
                    :loading="busy === 'group'"
                    size="xs"
                    type="submit"
                  >
                    Save
                  </UButton>
                </form>

                <div
                  v-if="existingGroups.length > 0"
                  class="space-y-0.5 border-t border-default pt-2"
                >
                  <button
                    v-for="g in existingGroups"
                    :key="g"
                    class="flex w-full cursor-pointer items-center justify-between rounded-md px-2 py-1 text-left text-xs transition-colors hover:bg-elevated"
                    :class="
                      node.group === g
                        ? 'font-medium text-default'
                        : 'text-muted'
                    "
                    type="button"
                    @click="onSaveGroup(g)"
                  >
                    <span class="truncate">{{ g }}</span>
                    <UIcon
                      v-if="node.group === g"
                      class="size-3.5 shrink-0 text-primary"
                      name="i-lucide-check"
                    />
                  </button>
                </div>

                <div
                  v-if="node.group !== null"
                  class="border-t border-default pt-2"
                >
                  <UButton
                    block
                    color="neutral"
                    size="xs"
                    variant="ghost"
                    @click="onSaveGroup(null)"
                  >
                    Remove from group
                  </UButton>
                </div>
              </div>
            </template>
          </UPopover>

          <UTooltip
            :disabled="!node.public_managed"
            text="Managed by agent config"
          >
            <UButton
              color="neutral"
              :disabled="node.public_managed"
              :loading="busy === 'public'"
              size="xs"
              variant="soft"
              @click="onTogglePublic"
            >
              {{ node.is_public ? "Make private" : "Make public" }}
            </UButton>
          </UTooltip>
          <UButton
            v-if="isMuted"
            color="neutral"
            :loading="busy === 'mute:0'"
            size="xs"
            variant="soft"
            @click="onMute(0)"
          >
            Unmute
          </UButton>
          <template v-else>
            <UButton
              v-for="m in MUTE_OPTIONS"
              :key="m.secs"
              color="neutral"
              :loading="busy === `mute:${m.secs}`"
              size="xs"
              variant="soft"
              @click="onMute(m.secs)"
            >
              {{ m.label }}
            </UButton>
          </template>

          <ConfirmPopover
            confirm-color="primary"
            confirm-label="Rotate"
            label="Rotate token"
            :loading="busy === 'rotate'"
            variant="soft"
            @confirm="onRotateToken"
          >
            Rotate token for
            <strong>{{ node.id }}</strong>
            ? The current token will stop working.
          </ConfirmPopover>

          <ConfirmPopover
            color="error"
            label="Delete"
            :loading="busy === 'delete'"
            variant="soft"
            @confirm="onDelete"
          >
            Delete
            <strong>{{ node.id }}</strong>
            and its history?
          </ConfirmPopover>
        </div>
      </div>
    </div>

    <section
      v-if="node.system || disk"
      class="grid grid-cols-2 gap-x-8 gap-y-4 border-y border-default py-5 sm:grid-cols-4"
    >
      <div v-if="node.system?.cpu_pct !== undefined" class="space-y-1">
        <div class="text-xs text-muted">CPU</div>
        <div class="text-2xl font-semibold tracking-tight tabular-nums">
          {{ node.system.cpu_pct.toFixed(1) }}%
        </div>
        <div
          v-if="node.system.load_1m !== undefined"
          class="font-mono text-xs text-dimmed tabular-nums"
        >
          Load {{ node.system.load_1m.toFixed(2) }}
        </div>
      </div>

      <div v-if="memPct !== null && node.system" class="space-y-1">
        <div class="text-xs text-muted">Memory</div>
        <div class="text-2xl font-semibold tracking-tight tabular-nums">
          {{ Math.round(memPct) }}%
        </div>
        <div class="font-mono text-xs text-dimmed tabular-nums">
          {{
            formatUsage(
              node.system.mem_used_bytes!,
              node.system.mem_total_bytes!,
            )
          }}
        </div>
        <div
          v-if="swapUsage"
          class="font-mono text-[11px] text-dimmed tabular-nums"
        >
          Swap {{ swapUsage }}
        </div>
      </div>

      <div v-if="disk" class="space-y-1">
        <UDropdownMenu v-if="node.mounts.length > 1" :items="diskMenuItems">
          <button
            class="inline-flex cursor-pointer items-center gap-1 text-xs text-muted transition-colors hover:text-default"
            :disabled="busy === 'disk'"
            type="button"
          >
            <span>Disk ({{ disk.is_sum ? "Total" : disk.label }})</span>
            <UIcon class="size-3 text-dimmed" name="i-lucide-chevron-down" />
          </button>
        </UDropdownMenu>
        <div v-else class="text-xs text-muted">Disk ({{ disk.label }})</div>
        <div
          class="text-2xl font-semibold tracking-tight tabular-nums"
          :class="statusTextClass(disk.status, '')"
        >
          {{ disk.pct !== null ? `${Math.round(disk.pct)}%` : "Error" }}
        </div>
        <div class="font-mono text-xs text-dimmed tabular-nums">
          {{
            disk.pct !== null
              ? formatUsage(disk.used_bytes, disk.total_bytes)
              : (disk.error ?? "Unavailable")
          }}
        </div>
      </div>

      <div
        v-if="node.rx_bps !== null && node.tx_bps !== null"
        class="space-y-1"
      >
        <div class="text-xs text-muted">Network</div>
        <div class="space-y-0.5 pt-0.5 font-mono tabular-nums">
          <div class="text-sm font-semibold text-blue-600 dark:text-blue-400">
            ↓ {{ formatBps(node.rx_bps) }}
          </div>
          <div
            class="text-sm font-semibold text-violet-600 dark:text-violet-400"
          >
            ↑ {{ formatBps(node.tx_bps) }}
          </div>
        </div>
      </div>
    </section>

    <NodeChartsGrid
      v-model:window-secs="windowSecs"
      :history="activeHistory"
      :loading-window
      :node
      :probe-charts
    />

    <NodeTelemetryPanel :node :scalar-series />
  </div>
</template>
