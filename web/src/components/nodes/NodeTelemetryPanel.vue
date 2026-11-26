<script setup lang="ts">
import { createReusableTemplate } from "@vueuse/core";
import { computed, ref } from "vue";

import type {
  CheckSnapshot,
  DotStatus,
  NodeSummary,
  SeriesSnapshot,
} from "../../lib/index.ts";
import {
  formatMountText,
  formatSeriesValue,
  mountPercent,
  statusTextClass,
} from "../../lib/index.ts";
import StatusDot from "../ui/StatusDot.vue";
import UsageBar from "../ui/UsageBar.vue";

const props = defineProps<{
  node: NodeSummary;
  scalarSeries: readonly SeriesSnapshot[];
}>();

const detailOverrides = ref<Record<string, boolean>>({});
const [DefineRowLabel, RowLabel] = createReusableTemplate<{
  status: DotStatus;
  label: string;
  group?: string;
}>();

const hasStorage = computed(() => props.node.mounts.length > 0);
const hasChecksOrSeries = computed(
  () => props.node.checks.length > 0 || props.scalarSeries.length > 0,
);
const hasAnyCheckDetail = computed(() =>
  props.node.checks.some((c) => Boolean(c.detail)),
);

const isDetailOpen = (check: CheckSnapshot): boolean =>
  detailOverrides.value[check.key] ?? check.status !== "ok";

function toggleDetail(check: CheckSnapshot) {
  detailOverrides.value = {
    ...detailOverrides.value,
    [check.key]: !isDetailOpen(check),
  };
}

const isFailedZeroDays = (series: SeriesSnapshot): boolean =>
  series.unit === "days" &&
  series.status === "fail" &&
  series.value === 0 &&
  typeof series.summary === "string" &&
  series.summary.length > 0 &&
  !series.summary.startsWith("0 ");

const scalarDisplayValue = (series: SeriesSnapshot): string =>
  isFailedZeroDays(series)
    ? "Error"
    : formatSeriesValue(series.value, series.unit);

function scalarSummaryNote(series: SeriesSnapshot): string | null {
  if (!series.summary || !series.status || series.status === "ok") {
    return null;
  }
  const formatted = formatSeriesValue(series.value, series.unit);

  return series.summary.trim() === formatted ? null : series.summary;
}
</script>

<template>
  <DefineRowLabel v-slot="{ status, label, group }">
    <div class="flex min-w-0 items-center gap-2">
      <StatusDot :status />
      <span class="truncate font-medium">{{ label }}</span>
      <UBadge
        v-if="group"
        class="shrink-0"
        color="neutral"
        size="xs"
        variant="subtle"
      >
        {{ group }}
      </UBadge>
    </div>
  </DefineRowLabel>

  <section
    v-if="hasStorage || hasChecksOrSeries"
    class="grid grid-cols-1 items-start gap-8"
    :class="hasStorage && hasChecksOrSeries ? 'lg:grid-cols-2' : ''"
  >
    <div v-if="hasStorage" class="space-y-3">
      <h2 class="text-sm font-semibold">Storage</h2>
      <div class="divide-y divide-default border-y border-default">
        <div v-for="m in node.mounts" :key="m.path" class="space-y-2 py-3.5">
          <div
            class="flex flex-wrap items-baseline justify-between gap-2 text-xs"
          >
            <div class="flex items-baseline gap-2">
              <span class="font-semibold">{{ m.label ?? m.path }}</span>
              <span v-if="m.label" class="font-mono text-dimmed">
                {{ m.path }}
              </span>
            </div>
            <span
              class="font-mono tabular-nums"
              :class="statusTextClass(m.status)"
            >
              {{ formatMountText(m, true) }}
            </span>
          </div>
          <UsageBar :pct="mountPercent(m)" :status="m.status" />
        </div>
      </div>
    </div>

    <div v-if="hasChecksOrSeries" class="space-y-3">
      <h2 class="text-sm font-semibold">Checks</h2>
      <div class="divide-y divide-default border-y border-default">
        <div v-for="c in node.checks" :key="c.key">
          <component
            :is="c.detail ? 'button' : 'div'"
            :aria-expanded="c.detail ? isDetailOpen(c) : undefined"
            class="flex items-center justify-between gap-3 py-3.5 text-[13px]"
            :class="
              c.detail
                ? 'group -mx-2 w-[calc(100%+1rem)] cursor-pointer rounded-md px-2 text-left transition-colors hover:bg-elevated/60 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-primary'
                : ''
            "
            :type="c.detail ? 'button' : undefined"
            @click="c.detail && toggleDetail(c)"
          >
            <RowLabel :group="c.group" :label="c.label" :status="c.status" />
            <div class="flex shrink-0 items-center gap-2">
              <span
                class="font-mono text-xs"
                :class="statusTextClass(c.status)"
              >
                {{ c.summary ?? c.status }}
              </span>
              <span
                v-if="c.detail"
                aria-hidden="true"
                class="inline-flex size-6 items-center justify-center rounded-md text-dimmed transition-colors group-hover:text-default"
              >
                <UIcon
                  class="size-3.5 transition-transform"
                  :class="isDetailOpen(c) ? 'rotate-180' : ''"
                  name="i-lucide-chevron-down"
                />
              </span>
              <span
                v-else-if="hasAnyCheckDetail"
                aria-hidden="true"
                class="size-6 shrink-0"
              />
            </div>
          </component>

          <pre
            v-if="c.detail && isDetailOpen(c)"
            class="mb-3.5 max-h-56 overflow-auto rounded-lg bg-muted p-3 font-mono text-xs leading-relaxed"
            >{{ c.detail }}</pre>
        </div>

        <div
          v-for="s in scalarSeries"
          :key="s.key"
          class="space-y-1.5 py-3.5 text-[13px]"
        >
          <div class="flex items-center justify-between gap-3">
            <RowLabel
              :group="s.group"
              :label="s.label"
              :status="s.status ?? 'pending'"
            />
            <div class="flex shrink-0 items-center gap-2">
              <span
                class="font-mono text-xs tabular-nums"
                :class="statusTextClass(s.status ?? 'ok')"
              >
                {{ scalarDisplayValue(s) }}
              </span>
              <span
                v-if="hasAnyCheckDetail"
                aria-hidden="true"
                class="size-6 shrink-0"
              />
            </div>
          </div>
          <p
            v-if="scalarSummaryNote(s)"
            class="pl-4 font-mono text-xs break-all"
            :class="statusTextClass(s.status ?? 'ok')"
          >
            {{ scalarSummaryNote(s) }}
          </p>
        </div>
      </div>
    </div>
  </section>

  <section v-if="node.info.length > 0" class="space-y-3">
    <h2 class="text-sm font-semibold">System</h2>
    <div
      class="grid grid-cols-2 gap-6 border-y border-default py-4 sm:grid-cols-4"
    >
      <div v-for="item in node.info" :key="item.key" class="space-y-0.5">
        <div class="text-xs text-dimmed">{{ item.label }}</div>
        <div class="font-mono text-xs break-all">{{ item.value }}</div>
      </div>
    </div>
  </section>
</template>
