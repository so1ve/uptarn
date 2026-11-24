<script setup lang="ts">
import { computed } from "vue";

import type { NodeSummary } from "../../lib/index.ts";
import {
  formatAge,
  formatBps,
  formatDuration,
  formatMountText,
  formatUsage,
  memPercent,
  mountPercent,
  nodeIssueSummary,
  peakMount,
  statusTextClass,
} from "../../lib/index.ts";
import SparkMetric from "../ui/SparkMetric.vue";
import StatusDot from "../ui/StatusDot.vue";
import UsageBar from "../ui/UsageBar.vue";

const props = defineProps<{
  node: NodeSummary;
  now: number;
}>();

const offline = computed(() => props.node.overall_status === "offline");
const pending = computed(() => props.node.overall_status === "pending");
const isMuted = computed(() => props.node.muted_until > props.now);

const cpuPct = computed(() => props.node.system?.cpu_pct);
const memPct = computed(() => memPercent(props.node.system));
const topMount = computed(() => peakMount(props.node.mounts));

const hasCpu = computed(() => cpuPct.value !== undefined);
const hasMem = computed(() => memPct.value !== null);
const hasCompute = computed(() => hasCpu.value || hasMem.value);
const hasNet = computed(
  () => props.node.rx_bps !== null && props.node.tx_bps !== null,
);

const issue = computed(() =>
  offline.value || pending.value
    ? null
    : nodeIssueSummary(props.node, hasCompute.value),
);

const memCaption = computed(() =>
  props.node.system?.mem_used_bytes !== undefined &&
  props.node.system.mem_total_bytes !== undefined
    ? formatUsage(
        props.node.system.mem_used_bytes,
        props.node.system.mem_total_bytes,
      )
    : undefined,
);
</script>

<template>
  <RouterLink
    class="group flex flex-col justify-between gap-4 rounded-xl border border-default bg-elevated px-5 py-4 transition-colors hover:border-accented"
    :to="`/nodes/${encodeURIComponent(node.id)}`"
  >
    <div class="space-y-4">
      <div class="flex items-center justify-between gap-3">
        <div class="flex min-w-0 items-center gap-2">
          <StatusDot :status="node.overall_status" />
          <span
            class="truncate text-[14.5px] font-semibold tracking-tight transition-colors group-hover:text-primary"
          >
            {{ node.label }}
          </span>
          <UBadge
            v-if="node.is_public"
            class="shrink-0"
            color="neutral"
            size="xs"
            variant="subtle"
          >
            Public
          </UBadge>
          <UBadge
            v-if="isMuted"
            class="shrink-0"
            color="warning"
            size="xs"
            variant="subtle"
          >
            Muted
          </UBadge>
        </div>

        <span
          v-if="!offline && !pending && node.system"
          class="shrink-0 font-mono text-xs text-muted tabular-nums"
        >
          Up {{ formatDuration(node.system.uptime_secs) }}
        </span>
        <span
          v-else-if="offline"
          class="shrink-0 font-mono text-xs text-red-500 dark:text-red-400"
        >
          Offline
        </span>
      </div>

      <p v-if="pending" class="text-xs text-dimmed">Waiting for first report</p>

      <div v-else class="space-y-3" :class="offline ? 'opacity-50' : ''">
        <template v-if="hasCompute">
          <div
            class="grid gap-5"
            :class="hasCpu && hasMem ? 'grid-cols-2' : 'grid-cols-1'"
          >
            <SparkMetric
              v-if="hasCpu"
              :history="node.history._cpu ?? []"
              kind="cpu"
              :pct="cpuPct!"
            />
            <SparkMetric
              v-if="hasMem"
              :caption="memCaption"
              :history="node.history._mem ?? []"
              kind="memory"
              :pct="memPct!"
            />
          </div>

          <div
            class="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 font-mono text-xs text-muted tabular-nums"
          >
            <div class="flex items-center gap-3.5">
              <span v-if="node.system?.load_1m !== undefined">
                <span class="text-dimmed">Load</span>
                {{ node.system.load_1m.toFixed(2) }}
              </span>
              <span v-if="topMount">
                <span class="text-dimmed">Disk</span>
                <span
                  class="ml-1"
                  :class="statusTextClass(topMount.status, '')"
                >
                  {{
                    topMount.total_bytes > 0
                      ? `${Math.round(mountPercent(topMount))}%`
                      : "Error"
                  }}
                </span>
              </span>
            </div>
            <span v-if="hasNet" class="inline-flex items-center gap-3">
              <span class="text-blue-600 dark:text-blue-400">
                ↓ {{ formatBps(node.rx_bps!) }}
              </span>
              <span class="text-violet-600 dark:text-violet-400">
                ↑ {{ formatBps(node.tx_bps!) }}
              </span>
            </span>
          </div>
        </template>

        <div v-else-if="node.mounts.length > 0" class="space-y-3 py-0.5">
          <div
            v-for="m in node.mounts.slice(0, 3)"
            :key="m.path"
            class="space-y-1.5"
          >
            <div class="flex items-baseline justify-between gap-2 text-xs">
              <span class="truncate font-medium">{{ m.label ?? m.path }}</span>
              <span
                class="shrink-0 font-mono text-[11.5px] tabular-nums"
                :class="statusTextClass(m.status)"
              >
                {{ formatMountText(m) }}
              </span>
            </div>
            <UsageBar :pct="mountPercent(m)" :status="m.status" />
          </div>
        </div>
      </div>
    </div>

    <div
      v-if="issue || (offline && node.last_seen_at !== null)"
      class="border-t border-default pt-2.5 text-xs"
    >
      <span
        v-if="issue"
        class="block truncate"
        :class="statusTextClass(issue.tone)"
      >
        {{ issue.text }}
      </span>
      <span v-else class="block font-mono text-dimmed tabular-nums">
        Seen {{ formatAge(node.last_seen_at, now) }}
      </span>
    </div>
  </RouterLink>
</template>
