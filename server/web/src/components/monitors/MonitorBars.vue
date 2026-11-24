<script setup lang="ts">
import { computed } from "vue";

import type { MonitorSample } from "../../lib/index.ts";
import { formatAge, formatClock } from "../../lib/index.ts";

const props = defineProps<{
  samples: readonly MonitorSample[];
  now: number;
}>();

interface BarSlot {
  sample: MonitorSample | null;
  heightPct: number;
  tip: string;
}

const slots = computed<BarSlot[]>(() => {
  const total = 36;
  const recent = props.samples.slice(-total);
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
      return { sample: null, heightPct: 22, tip: "" };
    }
    const heightPct = sample.ok
      ? sample.latency_ms === null || maxLat === minLat
        ? 58
        : Math.round(34 + ((sample.latency_ms - minLat) / span) * 62)
      : 100;
    const statusText = sample.ok ? "OK" : "Failed";
    const msText =
      sample.latency_ms === null ? "" : ` ${Math.round(sample.latency_ms)} ms`;
    const tip = `${statusText}${msText} at ${formatClock(sample.ts)} (${formatAge(sample.ts, props.now)})`;

    return { sample, heightPct, tip };
  });
});
</script>

<template>
  <div class="grid h-7 grid-cols-36 items-end gap-[3px]">
    <template v-for="(slot, idx) in slots" :key="idx">
      <UTooltip v-if="slot.sample" :delay-duration="60" :text="slot.tip">
        <span
          class="block w-full cursor-crosshair rounded-[2px] transition-opacity hover:opacity-75"
          :class="slot.sample.ok ? 'bg-emerald-500' : 'bg-red-500'"
          :style="{ height: `${slot.heightPct}%` }"
        />
      </UTooltip>
      <span
        v-else
        class="block h-[22%] w-full rounded-[2px] bg-zinc-200 dark:bg-zinc-800"
      />
    </template>
  </div>
</template>
