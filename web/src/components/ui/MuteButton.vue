<script setup lang="ts">
import { computed, ref } from "vue";

import type { TargetType } from "../../lib/index.ts";
import {
  apiFetch,
  formatDuration,
  formatRemaining,
  useAction,
} from "../../lib/index.ts";

const props = withDefaults(
  defineProps<{
    targetType: TargetType | "global";
    targetId?: string;
    label?: string;
    scopeNote?: string;
    mutedUntil: number;
    now: number;
    variant?: "ghost" | "soft";
    iconOnly?: boolean;
    mutedOnly?: boolean;
  }>(),
  { variant: "ghost", iconOnly: false, mutedOnly: false },
);

const PRESETS = [
  { label: "30m", secs: 1800 },
  { label: "1h", secs: 3600 },
  { label: "6h", secs: 21_600 },
  { label: "24h", secs: 86_400 },
] as const;

const UNITS = [
  { label: "m", secs: 60, max: 1440 },
  { label: "h", secs: 3600, max: 720 },
  { label: "d", secs: 86_400, max: 30 },
] as const;

type UnitLabel = (typeof UNITS)[number]["label"];

const { busy, run, mute } = useAction();
const open = ref(false);
const customAmount = ref("");
const customUnit = ref<UnitLabel>("h");

const isMuted = computed(() => props.mutedUntil > props.now);
const actionKey = computed(() =>
  props.targetType === "global"
    ? "mute:global"
    : `mute:${props.targetType}:${props.targetId ?? ""}`,
);
const isBusy = computed(() => busy.value === actionKey.value);

const remainingText = computed(() =>
  isMuted.value ? formatRemaining(props.mutedUntil, props.now) : "",
);

const untilLabel = computed(() => {
  if (!isMuted.value) {
    return "";
  }
  const end = new Date(props.mutedUntil * 1000);
  const nowDate = new Date(props.now * 1000);
  const sameDay =
    end.getFullYear() === nowDate.getFullYear() &&
    end.getMonth() === nowDate.getMonth() &&
    end.getDate() === nowDate.getDate();

  return end.toLocaleString(
    undefined,
    sameDay
      ? { hour: "2-digit", minute: "2-digit", hour12: false }
      : {
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        },
  );
});

const triggerLabel = computed(() => {
  if (isMuted.value) {
    return props.targetType === "global"
      ? `All muted ${remainingText.value}`
      : `Muted ${remainingText.value}`;
  }

  return props.targetType === "global" ? "Mute all" : "Mute";
});

const triggerAriaLabel = computed(() => {
  const target =
    props.targetType === "global"
      ? "all notifications"
      : (props.label ?? props.targetType);

  return isMuted.value
    ? `Muted ${target} (${remainingText.value} remaining)`
    : `Mute ${target}`;
});

const activeUnit = computed(
  () => UNITS.find((u) => u.label === customUnit.value) ?? UNITS[1],
);

const customSecs = computed(() => {
  const n = Number.parseInt(customAmount.value, 10);
  if (!Number.isInteger(n) || n < 1 || n > activeUnit.value.max) {
    return null;
  }

  return n * activeUnit.value.secs;
});

async function applyMute(durationSecs: number) {
  let ok = false;
  if (props.targetType === "global") {
    ok = await run(
      actionKey.value,
      "Failed to update mute",
      async () => {
        await apiFetch("/api/v1/admin/settings", "PATCH", {
          global_mute_secs: durationSecs,
        });

        return durationSecs > 0
          ? `Muted all notifications for ${formatDuration(durationSecs)}`
          : "All notifications unmuted";
      },
      true,
    );
  } else if (props.targetId) {
    ok = await mute(
      actionKey.value,
      props.targetType,
      props.targetId,
      props.label ?? props.targetId,
      durationSecs,
    );
  }
  if (ok) {
    customAmount.value = "";
    open.value = false;
  }
}

function onCustomSubmit() {
  if (customSecs.value === null) {
    return;
  }
  void applyMute(customSecs.value);
}
</script>

<template>
  <UPopover v-if="!mutedOnly || isMuted" v-model:open="open">
    <UButton
      :aria-label="iconOnly ? triggerAriaLabel : undefined"
      :class="isMuted ? 'tabular-nums' : ''"
      :color="isMuted ? 'warning' : 'neutral'"
      icon="i-lucide-bell-off"
      :loading="isBusy"
      size="xs"
      :variant="isMuted ? 'soft' : variant"
      @click.stop
    >
      <template v-if="!iconOnly">{{ triggerLabel }}</template>
    </UButton>

    <template #content>
      <div class="w-60 space-y-2.5 p-3" @click.stop>
        <div
          v-if="isMuted"
          class="flex items-center justify-between gap-2 border-b border-default pb-2"
        >
          <div class="min-w-0 space-y-0.5">
            <div
              class="text-xs font-medium text-amber-600 tabular-nums dark:text-amber-400"
            >
              Muted {{ remainingText }}
            </div>
            <div class="text-[11px] text-dimmed tabular-nums">
              Until {{ untilLabel }}
            </div>
          </div>
          <UButton
            color="primary"
            :loading="isBusy"
            size="xs"
            variant="soft"
            @click="applyMute(0)"
          >
            Unmute
          </UButton>
        </div>

        <p v-if="scopeNote" class="text-[11px] leading-snug text-muted">
          {{ scopeNote }}
        </p>

        <div class="grid grid-cols-4 gap-1.5">
          <UButton
            v-for="p in PRESETS"
            :key="p.secs"
            block
            color="neutral"
            :disabled="isBusy"
            size="xs"
            variant="soft"
            @click="applyMute(p.secs)"
          >
            {{ p.label }}
          </UButton>
        </div>

        <form
          class="flex items-center gap-1.5 border-t border-default pt-2"
          @submit.prevent="onCustomSubmit"
        >
          <UInput
            v-model="customAmount"
            aria-label="Custom mute duration"
            class="min-w-0 flex-1 tabular-nums"
            :max="activeUnit.max"
            min="1"
            placeholder="Custom"
            size="xs"
            step="1"
            type="number"
          />
          <div
            aria-label="Duration unit"
            class="inline-flex shrink-0 overflow-hidden rounded-md border border-default"
            role="group"
          >
            <button
              v-for="u in UNITS"
              :key="u.label"
              class="px-1.5 py-1 font-mono text-[11px] transition-colors"
              :class="
                customUnit === u.label
                  ? 'bg-elevated font-semibold text-default'
                  : 'text-muted hover:text-default'
              "
              type="button"
              @click="customUnit = u.label"
            >
              {{ u.label }}
            </button>
          </div>
          <UButton
            color="neutral"
            :disabled="customSecs === null || isBusy"
            size="xs"
            type="submit"
            variant="soft"
          >
            Set
          </UButton>
        </form>
      </div>
    </template>
  </UPopover>
</template>
