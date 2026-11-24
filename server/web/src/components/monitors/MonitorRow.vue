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
  monitorTarget,
  sampleUptime,
} from "../../lib/index.ts";
import StatusDot from "../ui/StatusDot.vue";
import MonitorBars from "./MonitorBars.vue";

const emit = defineEmits<{
  toggle: [];
  edit: [];
}>();

const props = defineProps<{
  monitor: MonitorSummary | PublicMonitorSummary;
  now: number;
  expanded?: boolean;
}>();

const isAdminMonitor = (
  m: MonitorSummary | PublicMonitorSummary,
): m is MonitorSummary => "url" in m;

const dotStatus = computed<DotStatus>(() =>
  !props.monitor.enabled || props.monitor.last_status === "pending"
    ? "pending"
    : props.monitor.last_status,
);

const uptime = computed(() => sampleUptime(props.monitor.samples));

const uptimeClass = computed(() => {
  if (uptime.value === null) {
    return "text-dimmed";
  }
  if (uptime.value >= 99) {
    return "text-emerald-600 dark:text-emerald-400";
  }

  return uptime.value >= 90
    ? "text-amber-600 dark:text-amber-400"
    : "text-red-500 dark:text-red-400";
});
</script>

<template>
  <div
    :aria-expanded="isAdminMonitor(monitor) ? Boolean(expanded) : undefined"
    class="grid grid-cols-1 items-center gap-x-5 gap-y-2.5 py-3.5"
    :class="[
      isAdminMonitor(monitor)
        ? 'cursor-pointer px-2 transition-colors hover:bg-elevated/60 lg:grid-cols-[minmax(13rem,1.2fr)_minmax(13rem,1.65fr)_4.5rem_minmax(9rem,0.9fr)_auto]'
        : 'px-1 lg:grid-cols-[minmax(12rem,1.1fr)_minmax(14rem,1.8fr)_4.5rem_minmax(7rem,0.8fr)]',
      !monitor.enabled ? 'opacity-60' : '',
    ]"
    @click="isAdminMonitor(monitor) && emit('toggle')"
  >
    <div class="min-w-0 space-y-0.5">
      <div class="flex items-center gap-2">
        <UIcon
          v-if="isAdminMonitor(monitor)"
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
        <template v-if="isAdminMonitor(monitor)">
          <UBadge
            v-if="!monitor.is_public"
            color="neutral"
            size="xs"
            variant="subtle"
          >
            Private
          </UBadge>
          <UBadge
            v-if="monitor.muted_until > now"
            color="warning"
            size="xs"
            variant="subtle"
          >
            Muted {{ formatRemaining(monitor.muted_until, now) }}
          </UBadge>
        </template>
      </div>

      <a
        v-if="isAdminMonitor(monitor)"
        class="inline-flex max-w-full items-center gap-1 pl-9 font-mono text-[11.5px] text-dimmed transition-colors hover:text-primary"
        :href="monitor.url"
        rel="noreferrer"
        target="_blank"
        @click.stop
      >
        <span class="truncate">{{ monitorTarget(monitor) }}</span>
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
      <template v-if="isAdminMonitor(monitor)">
        <span
          v-if="monitor.last_error"
          class="truncate text-red-500 dark:text-red-400"
          :title="monitor.last_error"
        >
          {{ monitor.last_error }}
        </span>
        <span v-else-if="monitor.last_latency_ms === null" class="text-dimmed">
          -
        </span>
        <span v-else class="inline-flex items-baseline gap-2">
          <span class="text-muted">{{ monitor.last_http_status }}</span>
          <span>{{ Math.round(monitor.last_latency_ms) }} ms</span>
        </span>
      </template>
      <template v-else>
        <span
          v-if="monitor.status_detail"
          class="text-red-500 dark:text-red-400"
        >
          {{ monitor.status_detail }}
        </span>
        <span v-else-if="monitor.last_latency_ms === null" class="text-dimmed">
          -
        </span>
        <span v-else>{{ Math.round(monitor.last_latency_ms) }} ms</span>
      </template>

      <span class="text-[11px] text-dimmed">
        {{ formatAge(monitor.last_checked_at, now) }}
      </span>
    </div>

    <UButton
      v-if="isAdminMonitor(monitor)"
      aria-label="Edit monitor"
      color="neutral"
      icon="i-lucide-pencil"
      size="xs"
      variant="ghost"
      @click.stop="emit('edit')"
    />
  </div>
</template>
