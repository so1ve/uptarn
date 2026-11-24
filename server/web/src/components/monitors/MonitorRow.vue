<script setup lang="ts">
import { computed } from "vue";

import type {
  DotStatus,
  MonitorSummary,
  PublicMonitorSummary,
} from "../../lib/index.ts";
import {
  formatAge,
  formatRemaining,
  sampleUptime,
  stripUrlScheme,
} from "../../lib/index.ts";
import DragHandle from "../ui/DragHandle.vue";
import StatusDot from "../ui/StatusDot.vue";
import MonitorBars from "./MonitorBars.vue";

const emit = defineEmits<{
  toggle: [];
  edit: [];
  moveUp: [];
  moveDown: [];
}>();

const props = defineProps<{
  monitor: MonitorSummary | PublicMonitorSummary;
  now: number;
  expanded?: boolean;
  reorderable?: boolean;
}>();

const adminMon = computed<MonitorSummary | null>(() =>
  "url" in props.monitor ? props.monitor : null,
);

const dotStatus = computed<DotStatus>(() =>
  !props.monitor.enabled || props.monitor.last_status === "pending"
    ? "pending"
    : props.monitor.last_status,
);

const uptime = computed(() => sampleUptime(props.monitor.samples));

const displayLink = computed(() => {
  if (adminMon.value) {
    const hostPath = stripUrlScheme(adminMon.value.url);

    return {
      href: adminMon.value.url,
      text:
        adminMon.value.method === "GET"
          ? hostPath
          : `${adminMon.value.method} ${hostPath}`,
    };
  }
  const url = (props.monitor as PublicMonitorSummary).public_url;

  return url ? { href: url, text: stripUrlScheme(url) } : null;
});

const uptimeClass = computed(() =>
  uptime.value === null
    ? "text-dimmed"
    : uptime.value >= 99
      ? "text-emerald-600 dark:text-emerald-400"
      : uptime.value >= 90
        ? "text-amber-600 dark:text-amber-400"
        : "text-red-500 dark:text-red-400",
);

const errorText = computed(() =>
  adminMon.value
    ? adminMon.value.last_error
    : (props.monitor as PublicMonitorSummary).status_detail,
);
</script>

<template>
  <div
    :aria-expanded="adminMon ? Boolean(expanded) : undefined"
    class="grid grid-cols-1 items-center gap-x-5 gap-y-2.5 py-3.5"
    :class="[
      adminMon
        ? 'cursor-pointer px-2 transition-colors hover:bg-elevated/60 lg:grid-cols-[minmax(13rem,1.2fr)_minmax(13rem,1.65fr)_4.5rem_minmax(9rem,0.9fr)_auto]'
        : 'px-1 lg:grid-cols-[minmax(12rem,1.1fr)_minmax(14rem,1.8fr)_4.5rem_minmax(7rem,0.8fr)]',
      !monitor.enabled ? 'opacity-60' : '',
    ]"
    @click="adminMon && emit('toggle')"
  >
    <div class="min-w-0 space-y-0.5">
      <div class="flex items-center gap-2">
        <DragHandle
          v-if="reorderable && adminMon"
          class="-ml-1"
          label="monitor"
          @move-down="emit('moveDown')"
          @move-up="emit('moveUp')"
        />
        <UIcon
          v-if="adminMon"
          class="size-3.5 shrink-0 text-dimmed transition-transform duration-150"
          :class="expanded ? 'rotate-90 text-default' : ''"
          name="i-lucide-chevron-right"
        />
        <StatusDot :status="dotStatus" />
        <span class="truncate text-[13.5px] font-semibold">
          {{ monitor.name }}
        </span>
        <UBadge
          v-if="!monitor.enabled"
          color="neutral"
          size="xs"
          variant="subtle"
        >
          Paused
        </UBadge>
        <UBadge
          v-if="adminMon && !adminMon.is_public"
          color="neutral"
          size="xs"
          variant="subtle"
        >
          Private
        </UBadge>
        <UBadge
          v-if="adminMon && adminMon.muted_until > now"
          color="warning"
          size="xs"
          variant="subtle"
        >
          Muted {{ formatRemaining(adminMon.muted_until, now) }}
        </UBadge>
      </div>

      <a
        v-if="displayLink"
        class="inline-flex max-w-full items-center gap-1 font-mono text-[11.5px] text-dimmed transition-colors hover:text-primary"
        :class="adminMon ? (reorderable ? 'pl-15' : 'pl-9') : 'pl-4'"
        :href="displayLink.href"
        rel="noreferrer"
        target="_blank"
        @click.stop
      >
        <span class="truncate">{{ displayLink.text }}</span>
        <UIcon class="size-3 shrink-0" name="i-lucide-external-link" />
      </a>
    </div>

    <div @click.stop>
      <MonitorBars :now :samples="monitor.samples" />
    </div>

    <div class="font-mono text-xs font-semibold tabular-nums lg:text-right">
      <span :class="uptimeClass">
        {{
          uptime === null
            ? "-"
            : uptime === 100
              ? "100%"
              : `${uptime.toFixed(1)}%`
        }}
      </span>
    </div>

    <div
      class="flex items-baseline justify-between gap-2 font-mono text-xs tabular-nums lg:flex-col lg:items-end lg:gap-0.5"
    >
      <span
        v-if="errorText"
        class="truncate text-red-500 dark:text-red-400"
        :title="errorText"
      >
        {{ errorText }}
      </span>
      <span v-else-if="monitor.last_latency_ms === null" class="text-dimmed">
        -
      </span>
      <span v-else class="inline-flex items-baseline gap-2">
        <span v-if="adminMon" class="text-muted">
          {{ adminMon.last_http_status }}
        </span>
        <span>{{ Math.round(monitor.last_latency_ms) }} ms</span>
      </span>

      <span class="text-[11px] text-dimmed">
        {{ formatAge(monitor.last_checked_at, now) }}
      </span>
    </div>

    <UTooltip
      v-if="adminMon"
      :disabled="!adminMon.managed_by_node_id"
      :text="
        adminMon.managed_by_node_id
          ? `Managed by ${adminMon.managed_by_node_id}`
          : undefined
      "
    >
      <UButton
        :aria-label="
          adminMon.managed_by_node_id
            ? `Managed by ${adminMon.managed_by_node_id}`
            : 'Edit monitor'
        "
        color="neutral"
        :disabled="Boolean(adminMon.managed_by_node_id)"
        icon="i-lucide-pencil"
        size="xs"
        variant="ghost"
        @click.stop="!adminMon.managed_by_node_id && emit('edit')"
      />
    </UTooltip>
  </div>
</template>
