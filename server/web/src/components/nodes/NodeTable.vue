<script setup lang="ts">
import { computed } from "vue";
import { useRouter } from "vue-router";

import type { NodeSummary } from "../../lib/index.ts";
import {
  formatAge,
  formatBps,
  formatDuration,
  formatUsage,
  memPercent,
  mountPercent,
  nodeIssueSummary,
  peakMount,
  statusTextClass,
} from "../../lib/index.ts";
import StatusDot from "../ui/StatusDot.vue";

const props = defineProps<{
  nodes: readonly NodeSummary[];
  now: number;
}>();

const router = useRouter();

const rows = computed(() =>
  props.nodes.map((node) => ({
    node,
    mem: memPercent(node.system),
    disk: peakMount(node.mounts),
    issue:
      node.overall_status === "offline" || node.overall_status === "pending"
        ? null
        : nodeIssueSummary(node),
  })),
);
</script>

<template>
  <div class="overflow-x-auto border-y border-default">
    <table class="w-full border-collapse text-left text-[13px]">
      <thead>
        <tr class="border-b border-default text-xs text-dimmed">
          <th class="py-2.5 pr-4 font-medium">Node</th>
          <th class="px-3 py-2.5 text-right font-medium">CPU</th>
          <th class="px-3 py-2.5 text-right font-medium">Mem</th>
          <th class="px-3 py-2.5 text-right font-medium">Disk</th>
          <th class="px-3 py-2.5 text-right font-medium">Net</th>
          <th class="px-3 py-2.5 text-right font-medium">Uptime</th>
          <th class="px-3 py-2.5 text-right font-medium">Seen</th>
          <th class="py-2.5 pl-4 font-medium">Status</th>
        </tr>
      </thead>
      <tbody class="divide-y divide-default">
        <tr
          v-for="{ node, mem, disk, issue } in rows"
          :key="node.id"
          class="cursor-pointer transition-colors hover:bg-muted/60"
          @click="router.push(`/nodes/${encodeURIComponent(node.id)}`)"
        >
          <td class="py-3 pr-4">
            <div class="flex items-center gap-2">
              <StatusDot :status="node.overall_status" />
              <span class="font-semibold">{{ node.label }}</span>
              <span
                v-if="node.label.toLowerCase() !== node.id.toLowerCase()"
                class="font-mono text-xs text-dimmed"
              >
                {{ node.id }}
              </span>
            </div>
          </td>
          <td class="px-3 py-3 text-right font-mono text-xs tabular-nums">
            <span v-if="node.system?.cpu_pct === undefined" class="text-dimmed">
              -
            </span>
            <span v-else>{{ Math.round(node.system.cpu_pct) }}%</span>
          </td>
          <td class="px-3 py-3 text-right font-mono text-xs tabular-nums">
            <span v-if="mem === null" class="text-dimmed">-</span>
            <span v-else>{{ Math.round(mem) }}%</span>
          </td>
          <td class="px-3 py-3 text-right font-mono text-xs tabular-nums">
            <span v-if="!disk" class="text-dimmed">-</span>
            <span
              v-else-if="disk.total_bytes === 0"
              class="text-red-500 dark:text-red-400"
            >
              Error
            </span>
            <span
              v-else
              :class="statusTextClass(disk.status, '')"
              :title="formatUsage(disk.used_bytes, disk.total_bytes)"
            >
              {{ Math.round(mountPercent(disk)) }}%
            </span>
          </td>
          <td
            class="px-3 py-3 text-right font-mono text-xs text-muted tabular-nums"
          >
            {{
              node.rx_bps !== null && node.tx_bps !== null
                ? `↓${formatBps(node.rx_bps)} ↑${formatBps(node.tx_bps)}`
                : "-"
            }}
          </td>
          <td
            class="px-3 py-3 text-right font-mono text-xs text-muted tabular-nums"
          >
            {{ node.system ? formatDuration(node.system.uptime_secs) : "-" }}
          </td>
          <td
            class="px-3 py-3 text-right font-mono text-xs tabular-nums"
            :class="
              node.overall_status === 'offline'
                ? 'text-red-500 dark:text-red-400'
                : 'text-muted'
            "
          >
            {{ formatAge(node.last_seen_at, now) }}
          </td>
          <td class="py-3 pl-4 text-xs">
            <span
              v-if="node.overall_status === 'offline'"
              class="text-red-500 dark:text-red-400"
            >
              Offline
            </span>
            <span
              v-else-if="node.overall_status === 'pending'"
              class="text-dimmed"
            >
              Pending
            </span>
            <span v-else-if="issue" :class="statusTextClass(issue.tone)">
              {{ issue.compact }}
            </span>
            <span v-else class="text-dimmed">OK</span>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
