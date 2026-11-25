<script setup lang="ts">
import { computed } from "vue";

import type {
  MonitorRollupBucket,
  MonitorSample,
  MonitorSummary,
  MonitorWindow,
  PublicIncidentSummary,
  PublicMonitorSummary,
} from "../../lib/index.ts";
import {
  ROLLUP_WINDOW_SPEC,
  formatAge,
  formatClock,
  formatDateShort,
  formatDuration,
  formatUptimePct,
} from "../../lib/index.ts";

const props = defineProps<{
  monitor: MonitorSummary | PublicMonitorSummary;
  window: MonitorWindow;
  now: number;
  incidents?: readonly PublicIncidentSummary[];
}>();

interface BarTooltip {
  header: string;
  headline: string;
  dotClass: string;
  toneClass: string;
  latency: string | null;
  ok?: number;
  failed?: number;
  total?: number;
  incidentNote?: string | null;
}

interface BarSlot {
  colorClass: string;
  heightPct: number;
  tip: BarTooltip | null;
}

const SLOT_TONE = {
  ok: { dot: "bg-emerald-500", text: "text-emerald-600 dark:text-emerald-400" },
  warn: { dot: "bg-amber-500", text: "text-amber-600 dark:text-amber-400" },
  fail: { dot: "bg-red-500", text: "text-red-500 dark:text-red-400" },
  empty: { dot: "bg-zinc-400 dark:bg-zinc-600", text: "text-muted" },
} as const;

const formatBucketRange = (
  ts: number,
  window: Exclude<MonitorWindow, "live">,
  step: number,
): string =>
  window === "24h"
    ? `${formatClock(ts)} - ${formatClock(ts + step)}`
    : window === "7d"
      ? `${formatDateShort(ts)} ${formatClock(ts)} - ${formatClock(ts + step)}`
      : formatDateShort(ts);

const slots = computed<BarSlot[]>(() => {
  if (props.window === "live") {
    const total = 36;
    const recent = props.monitor.samples.slice(-total);
    const okLatencies = recent
      .filter((s) => s.ok && s.latency_ms !== null)
      .map((s) => s.latency_ms!);
    const maxLat = Math.max(1, ...okLatencies);
    const minLat = okLatencies.length > 0 ? Math.min(...okLatencies) : 0;
    const span = Math.max(1, maxLat - minLat);

    const padded: (MonitorSample | null)[] = [
      ...Array.from({ length: total - recent.length }, () => null),
      ...recent,
    ];

    return padded.map((sample) => {
      if (!sample) {
        return {
          colorClass: "bg-zinc-200 dark:bg-zinc-800",
          heightPct: 22,
          tip: null,
        };
      }
      const heightPct = sample.ok
        ? sample.latency_ms === null || maxLat === minLat
          ? 58
          : Math.round(34 + ((sample.latency_ms - minLat) / span) * 62)
        : 100;

      const tone = sample.ok ? SLOT_TONE.ok : SLOT_TONE.fail;

      return {
        colorClass: tone.dot,
        heightPct,
        tip: {
          header: `${formatClock(sample.ts)} (${formatAge(sample.ts, props.now)})`,
          headline: sample.ok ? "Operational" : "Failed",
          dotClass: tone.dot,
          toneClass: tone.text,
          latency:
            sample.latency_ms === null
              ? null
              : `${Math.round(sample.latency_ms)} ms`,
        },
      };
    });
  }

  const { key, step, slots: count } = ROLLUP_WINDOW_SPEC[props.window];
  const endTs = Math.floor(props.now / step) * step;
  const startTs = endTs - (count - 1) * step;
  const byTs = new Map<number, MonitorRollupBucket>(
    props.monitor.rollups[key].map((b) => [b.ts, b]),
  );

  return Array.from({ length: count }, (_, idx) => {
    const ts = startTs + idx * step;
    const range = formatBucketRange(
      ts,
      props.window as Exclude<MonitorWindow, "live">,
      step,
    );
    const bucket = byTs.get(ts);
    if (!bucket || bucket.total === 0) {
      return {
        colorClass: "bg-zinc-200 dark:bg-zinc-800",
        heightPct: 22,
        tip: {
          header: range,
          headline: "No data",
          dotClass: SLOT_TONE.empty.dot,
          toneClass: SLOT_TONE.empty.text,
          latency: null,
        },
      };
    }
    const pct = (bucket.ok / bucket.total) * 100;
    const state =
      bucket.ok === bucket.total ? "ok" : pct >= 90 ? "warn" : "fail";
    const tone = SLOT_TONE[state];
    const bucketEnd = ts + step;
    const overlapping =
      props.incidents?.filter((inc) => {
        const end = inc.resolved_at ?? props.now;

        return inc.started_at < bucketEnd && end >= ts;
      }) ?? [];
    let incidentNote: string | null = null;
    if (overlapping.length === 1) {
      const inc = overlapping[0];
      const dur = formatDuration(
        Math.max(0, (inc.resolved_at ?? props.now) - inc.started_at),
      );
      incidentNote = `${inc.reason} (${dur})`;
    } else if (overlapping.length > 1) {
      incidentNote = `${overlapping.length} incidents (${overlapping[0].reason})`;
    }

    return {
      colorClass: tone.dot,
      heightPct: state === "ok" ? 74 : state === "warn" ? 88 : 100,
      tip: {
        header: range,
        headline: formatUptimePct(pct),
        dotClass: tone.dot,
        toneClass: tone.text,
        latency: bucket.avg_ms === null ? null : `${bucket.avg_ms} ms avg`,
        ok: bucket.ok,
        failed: bucket.total - bucket.ok,
        total: bucket.total,
        incidentNote,
      },
    };
  });
});
</script>

<template>
  <div
    class="grid h-7 items-end"
    :class="slots.length > 36 ? 'gap-[2px]' : 'gap-[3px]'"
    :style="{
      gridTemplateColumns: `repeat(${slots.length}, minmax(0, 1fr))`,
    }"
  >
    <template v-for="(slot, idx) in slots" :key="idx">
      <UTooltip
        v-if="slot.tip"
        :delay-duration="60"
        :ui="{ content: 'h-auto block p-2.5' }"
      >
        <span
          class="block w-full cursor-crosshair rounded-[2px] transition-opacity hover:opacity-75"
          :class="slot.colorClass"
          :style="{ height: `${slot.heightPct}%` }"
        />
        <template #content>
          <div class="min-w-44 space-y-1.5 font-sans">
            <div class="font-mono text-[11px] text-muted tabular-nums">
              {{ slot.tip.header }}
            </div>
            <div class="flex items-center justify-between gap-4">
              <span
                class="inline-flex items-center gap-1.5 text-xs font-semibold tabular-nums"
                :class="slot.tip.toneClass"
              >
                <span class="size-2 rounded-full" :class="slot.tip.dotClass" />
                {{ slot.tip.headline }}
              </span>
              <span
                v-if="slot.tip.latency"
                class="font-mono text-[11px] text-muted tabular-nums"
              >
                {{ slot.tip.latency }}
              </span>
            </div>
            <div
              v-if="slot.tip.total !== undefined"
              class="flex items-center justify-between gap-4 border-t border-default pt-1.5 font-mono text-[11px] tabular-nums"
            >
              <span class="text-muted">
                {{ slot.tip.ok }}/{{ slot.tip.total }} ok
              </span>
              <span
                v-if="slot.tip.failed && slot.tip.failed > 0"
                class="font-medium text-red-500 dark:text-red-400"
              >
                {{ slot.tip.failed }} failed
              </span>
              <span v-else class="text-dimmed">All passed</span>
            </div>
            <div
              v-if="slot.tip.incidentNote"
              class="border-t border-default pt-1.5 font-mono text-[11px] text-amber-600 dark:text-amber-400"
            >
              {{ slot.tip.incidentNote }}
            </div>
          </div>
        </template>
      </UTooltip>
      <span
        v-else
        class="block h-[22%] w-full rounded-[2px]"
        :class="slot.colorClass"
      />
    </template>
  </div>
</template>
