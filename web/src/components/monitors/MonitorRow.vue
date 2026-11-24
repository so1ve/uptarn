<script setup lang="ts">
import { computed } from "vue";

import type {
  DotStatus,
  MonitorSummary,
  MonitorWindow,
  PublicMonitorSummary,
} from "../../lib/index.ts";
import {
  MONITOR_WINDOWS,
  formatAge,
  formatRemaining,
  formatUptimePct,
  monitorUptime,
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

const props = withDefaults(
  defineProps<{
    monitor: MonitorSummary | PublicMonitorSummary;
    now: number;
    window?: MonitorWindow;
    expanded?: boolean;
    reorderable?: boolean;
  }>(),
  { window: "24h" },
);

const adminMon = computed<MonitorSummary | null>(() =>
  "url" in props.monitor ? props.monitor : null,
);

const dotStatus = computed<DotStatus>(() =>
  !props.monitor.enabled || props.monitor.last_status === "pending"
    ? "pending"
    : props.monitor.last_status,
);

const uptimeTone = (pct: number | null) =>
  pct === null
    ? "text-dimmed"
    : pct >= 99
      ? "text-emerald-600 dark:text-emerald-400"
      : pct >= 90
        ? "text-amber-600 dark:text-amber-400"
        : "text-red-500 dark:text-red-400";

const uptime = computed(() =>
  monitorUptime(props.monitor, props.window, props.now),
);

const uptimeBreakdown = computed(() =>
  MONITOR_WINDOWS.map((w) => {
    const stat = monitorUptime(props.monitor, w.id, props.now);

    return { ...w, ...stat, active: w.id === props.window };
  }),
);

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

const errorText = computed(() =>
  adminMon.value
    ? adminMon.value.last_error
    : (props.monitor as PublicMonitorSummary).status_detail,
);
</script>

<template>
  <div
    :aria-expanded="adminMon ? Boolean(expanded) : undefined"
    class="grid items-center gap-x-3 gap-y-2 py-3.5 lg:gap-x-5 lg:gap-y-2.5"
    :class="[
      adminMon
        ? 'cursor-pointer grid-cols-[minmax(0,1fr)_auto_auto] px-2 transition-colors hover:bg-elevated/60 lg:grid-cols-[minmax(13rem,1.2fr)_minmax(13rem,1.65fr)_4.5rem_minmax(9rem,0.9fr)_auto]'
        : 'grid-cols-[minmax(0,1fr)_auto] px-1 lg:grid-cols-[minmax(12rem,1.1fr)_minmax(14rem,1.8fr)_4.5rem_minmax(7rem,0.8fr)]',
      !monitor.enabled ? 'opacity-60' : '',
    ]"
    @click="adminMon && emit('toggle')"
  >
    <div class="order-1 flex min-w-0 items-start gap-2">
      <div class="flex h-5 shrink-0 items-center gap-2">
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
      </div>

      <div
        class="min-w-0 flex-1 space-y-0.5 [&:has(.monitor-link:hover)_.monitor-link]:text-primary"
      >
        <div class="flex min-w-0 items-center gap-1.5">
          <a
            v-if="displayLink"
            class="monitor-link truncate text-[13.5px] leading-5 font-semibold transition-colors"
            :href="displayLink.href"
            rel="noreferrer"
            target="_blank"
            @click.stop
          >
            {{ monitor.name }}
          </a>
          <span v-else class="truncate text-[13.5px] leading-5 font-semibold">
            {{ monitor.name }}
          </span>

          <UBadge
            v-if="!monitor.enabled"
            class="shrink-0"
            color="neutral"
            size="xs"
            variant="subtle"
          >
            Paused
          </UBadge>
          <UBadge
            v-if="adminMon && !adminMon.is_public"
            class="shrink-0"
            color="neutral"
            size="xs"
            variant="subtle"
          >
            Private
          </UBadge>
          <UBadge
            v-if="adminMon && adminMon.muted_until > now"
            class="shrink-0"
            color="warning"
            size="xs"
            variant="subtle"
          >
            Muted {{ formatRemaining(adminMon.muted_until, now) }}
          </UBadge>
        </div>

        <a
          v-if="displayLink"
          class="monitor-link inline-flex max-w-full items-center gap-1 font-mono text-[11.5px] text-dimmed transition-colors"
          :href="displayLink.href"
          rel="noreferrer"
          target="_blank"
          @click.stop
        >
          <span class="truncate">{{ displayLink.text }}</span>
          <UIcon class="size-3 shrink-0" name="i-lucide-external-link" />
        </a>
      </div>
    </div>

    <div
      class="font-mono text-xs font-semibold tabular-nums"
      :class="
        adminMon
          ? 'order-2 self-start pt-0.5 text-right lg:order-3 lg:self-center lg:pt-0'
          : 'order-2 self-start pt-0.5 text-right lg:order-3 lg:self-center lg:pt-0'
      "
    >
      <UTooltip
        :delay-duration="80"
        :disabled="uptime.total === 0"
        :ui="{ content: 'h-auto block p-2.5' }"
      >
        <span class="cursor-default" :class="uptimeTone(uptime.pct)">
          {{ formatUptimePct(uptime.pct) }}
        </span>
        <template #content>
          <div class="min-w-48 space-y-1.5 font-sans">
            <div class="text-[11px] font-medium text-muted">Uptime</div>
            <div class="space-y-1 font-mono text-[11px] tabular-nums">
              <div
                v-for="item in uptimeBreakdown"
                :key="item.id"
                class="grid grid-cols-[2.5rem_3.75rem_1fr] items-center gap-2"
                :class="item.active ? 'font-semibold' : 'opacity-80'"
              >
                <span :class="item.active ? 'text-default' : 'text-muted'">
                  {{ item.label }}
                </span>
                <span class="text-right" :class="uptimeTone(item.pct)">
                  {{ formatUptimePct(item.pct) }}
                </span>
                <span class="text-right text-dimmed">
                  {{ item.total > 0 ? `${item.ok}/${item.total}` : "-" }}
                </span>
              </div>
            </div>
          </div>
        </template>
      </UTooltip>
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
        class="order-3 self-start lg:order-5 lg:self-center"
        color="neutral"
        :disabled="Boolean(adminMon.managed_by_node_id)"
        icon="i-lucide-pencil"
        size="xs"
        variant="ghost"
        @click.stop="!adminMon.managed_by_node_id && emit('edit')"
      />
    </UTooltip>

    <div
      :class="
        adminMon
          ? 'order-4 col-span-3 lg:order-2 lg:col-span-1'
          : 'order-3 col-span-2 lg:order-2 lg:col-span-1'
      "
      @click.stop
    >
      <MonitorBars :monitor :now :window />
    </div>

    <div
      class="flex items-baseline justify-between gap-2 font-mono text-xs tabular-nums lg:flex-col lg:items-end lg:gap-0.5"
      :class="
        adminMon
          ? 'order-5 col-span-3 lg:order-4 lg:col-span-1'
          : 'order-4 col-span-2 lg:order-4 lg:col-span-1'
      "
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
      <span v-else class="inline-flex items-center gap-1.5">
        <span
          v-if="adminMon && adminMon.last_http_status !== null"
          class="rounded bg-muted px-1.5 py-0.5 text-[10.5px] leading-none text-muted"
        >
          HTTP {{ adminMon.last_http_status }}
        </span>
        <span>{{ Math.round(monitor.last_latency_ms) }} ms</span>
      </span>

      <span class="text-[11px] text-dimmed">
        {{ formatAge(monitor.last_checked_at, now) }}
      </span>
    </div>
  </div>
</template>
