<script setup lang="ts">
import { computed } from "vue";
import { useRoute, useRouter } from "vue-router";

import NodeChartsGrid from "../components/nodes/NodeChartsGrid.vue";
import NodeTelemetryPanel from "../components/nodes/NodeTelemetryPanel.vue";
import ConfirmPopover from "../components/ui/ConfirmPopover.vue";
import StatusDot from "../components/ui/StatusDot.vue";
import {
  apiFetch,
  buildProbeCharts,
  formatAge,
  formatBps,
  formatDuration,
  formatRemaining,
  formatUsage,
  memPercent,
  mountPercent,
  peakMount,
  statusTextClass,
  useAction,
  useSnapshot,
  useUptarnStore,
} from "../lib/index.ts";

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
const topMount = computed(() =>
  node.value ? peakMount(node.value.mounts) : null,
);

const probeCharts = computed(() =>
  node.value ? buildProbeCharts(node.value, isDark.value) : [],
);

const scalarSeries = computed(() => {
  if (!node.value) {
    return [];
  }
  const charted = new Set(probeCharts.value.map((p) => p.series.key));

  return node.value.series.filter((s) => !charted.has(s.key));
});

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
      await apiFetch(
        `/api/v1/admin/nodes/${encodeURIComponent(node.value!.id)}`,
        "PATCH",
        { is_public: next },
      );

      return next ? "Shown on status page" : "Hidden from status page";
    },
    true,
  );

const onRotateToken = () =>
  node.value &&
  run("rotate", "Token rotation failed", async () => {
    const res = await apiFetch<{ id: string; token: string }>(
      `/api/v1/admin/nodes/${encodeURIComponent(node.value!.id)}/rotate-token`,
      "POST",
    );
    showIssuedToken(res);
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
      await apiFetch(
        `/api/v1/admin/nodes/${encodeURIComponent(n.id)}`,
        "DELETE",
      );

      return `Deleted ${n.label}`;
    },
    true,
  );
  if (ok) {
    await router.push("/");
  }
}
</script>

<template>
  <div v-if="!node" class="space-y-4 py-12 text-center">
    <p class="text-sm text-muted">Node "{{ nodeId }}" was not found.</p>
    <UButton color="neutral" to="/" variant="soft">Back to nodes</UButton>
  </div>

  <div v-else class="space-y-8">
    <div class="space-y-3">
      <RouterLink
        class="inline-flex items-center gap-1.5 text-xs font-medium text-muted transition-colors hover:text-default"
        to="/"
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
              v-if="node.is_public"
              color="neutral"
              size="xs"
              variant="subtle"
            >
              Public
            </UBadge>
            <UBadge v-if="isMuted" color="warning" size="xs" variant="subtle">
              Muted {{ formatRemaining(node.muted_until, snap.now) }}
            </UBadge>
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
          <UButton
            color="neutral"
            :loading="busy === 'public'"
            size="xs"
            variant="soft"
            @click="onTogglePublic"
          >
            {{ node.is_public ? "Make private" : "Make public" }}
          </UButton>
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
              color="neutral"
              :loading="busy === 'mute:3600'"
              size="xs"
              variant="soft"
              @click="onMute(3600)"
            >
              Mute 1h
            </UButton>
            <UButton
              color="neutral"
              :loading="busy === 'mute:86400'"
              size="xs"
              variant="soft"
              @click="onMute(86400)"
            >
              Mute 1d
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
      v-if="node.system || topMount"
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

      <div
        v-if="
          memPct !== null &&
          node.system?.mem_used_bytes !== undefined &&
          node.system.mem_total_bytes !== undefined
        "
        class="space-y-1"
      >
        <div class="text-xs text-muted">Memory</div>
        <div class="text-2xl font-semibold tracking-tight tabular-nums">
          {{ Math.round(memPct) }}%
        </div>
        <div class="font-mono text-xs text-dimmed tabular-nums">
          {{
            formatUsage(node.system.mem_used_bytes, node.system.mem_total_bytes)
          }}
        </div>
      </div>

      <div v-if="topMount" class="space-y-1">
        <div class="text-xs text-muted">
          Disk ({{ topMount.label ?? topMount.path }})
        </div>
        <div
          class="text-2xl font-semibold tracking-tight tabular-nums"
          :class="statusTextClass(topMount.status, '')"
        >
          {{
            topMount.total_bytes > 0
              ? `${Math.round(mountPercent(topMount))}%`
              : "Error"
          }}
        </div>
        <div class="font-mono text-xs text-dimmed tabular-nums">
          {{
            topMount.total_bytes > 0
              ? formatUsage(topMount.used_bytes, topMount.total_bytes)
              : (topMount.summary ?? "Unavailable")
          }}
        </div>
      </div>

      <div
        v-if="node.rx_bps !== null && node.tx_bps !== null"
        class="space-y-1"
      >
        <div class="text-xs text-muted">Network</div>
        <div
          class="text-lg font-semibold tracking-tight text-blue-600 tabular-nums dark:text-blue-400"
        >
          ↓ {{ formatBps(node.rx_bps) }}
        </div>
        <div
          class="font-mono text-xs text-violet-600 tabular-nums dark:text-violet-400"
        >
          ↑ {{ formatBps(node.tx_bps) }}
        </div>
      </div>
    </section>

    <NodeChartsGrid :node :probe-charts />

    <NodeTelemetryPanel :node :scalar-series />
  </div>
</template>
