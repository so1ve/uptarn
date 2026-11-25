<script setup lang="ts">
import { computed } from "vue";

import type { TargetType } from "../../lib/index.ts";
import { useAction } from "../../lib/index.ts";

const props = withDefaults(
  defineProps<{
    targetType: TargetType;
    targetId: string;
    label: string;
    mutedUntil: number;
    now: number;
    durationSecs?: number;
    variant?: "ghost" | "soft";
  }>(),
  { durationSecs: 3600, variant: "ghost" },
);

const { busy, mute } = useAction();
const isMuted = computed(() => props.mutedUntil > props.now);
const actionKey = computed(() => `mute:${props.targetType}:${props.targetId}`);

const onClick = () =>
  mute(
    actionKey.value,
    props.targetType,
    props.targetId,
    props.label,
    isMuted.value ? 0 : props.durationSecs,
  );
</script>

<template>
  <UButton
    color="neutral"
    :loading="busy === actionKey"
    size="xs"
    :variant
    @click="onClick"
  >
    {{ isMuted ? "Unmute" : "Mute 1h" }}
  </UButton>
</template>
