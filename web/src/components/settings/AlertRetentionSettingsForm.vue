<script setup lang="ts">
import { computed, ref, watch } from "vue";

import { apiFetch, useAction, useSnapshot } from "../../lib/index.ts";

const snap = useSnapshot();
const { busy, run } = useAction();

const failureThreshold = ref("2");
const retentionDays = ref("14");
const dirty = ref(false);

function syncFromSnapshot() {
  failureThreshold.value = String(snap.value.settings.failure_threshold);
  retentionDays.value = String(snap.value.settings.retention_days);
  dirty.value = false;
}

watch(
  () => [
    snap.value.settings.failure_threshold,
    snap.value.settings.retention_days,
  ],
  () => {
    if (!dirty.value) {
      syncFromSnapshot();
    }
  },
  { immediate: true },
);

const parsedThreshold = computed(() =>
  Number.parseInt(failureThreshold.value, 10),
);
const parsedRetention = computed(() =>
  Number.parseInt(retentionDays.value, 10),
);

const valid = computed(
  () =>
    Number.isInteger(parsedThreshold.value) &&
    parsedThreshold.value >= 1 &&
    parsedThreshold.value <= 10 &&
    Number.isInteger(parsedRetention.value) &&
    parsedRetention.value >= 1 &&
    parsedRetention.value <= 365,
);

const hasChanges = computed(
  () =>
    parsedThreshold.value !== snap.value.settings.failure_threshold ||
    parsedRetention.value !== snap.value.settings.retention_days,
);

function onThresholdInput(val: string | number) {
  failureThreshold.value = String(val);
  dirty.value = true;
}

function onRetentionInput(val: string | number) {
  retentionDays.value = String(val);
  dirty.value = true;
}

async function onSubmit() {
  if (!valid.value) {
    return;
  }
  const ok = await run(
    "policy",
    "Could not save alert and retention settings",
    async () => {
      await apiFetch("/api/v1/admin/settings", "PATCH", {
        failure_threshold: parsedThreshold.value,
        retention_days: parsedRetention.value,
      });

      return "Alert and retention settings saved";
    },
    true,
  );
  if (ok) {
    dirty.value = false;
  }
}
</script>

<template>
  <form class="space-y-4" @submit.prevent="onSubmit">
    <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <UFormField
        hint="1–10 failures"
        label="Failure threshold"
        name="failure_threshold"
      >
        <UInput
          class="w-full tabular-nums"
          :max="10"
          :min="1"
          :model-value="failureThreshold"
          required
          step="1"
          type="number"
          @update:model-value="onThresholdInput"
        />
      </UFormField>

      <UFormField
        hint="1–365 days"
        label="History retention"
        name="retention_days"
      >
        <UInput
          class="w-full tabular-nums"
          :max="365"
          :min="1"
          :model-value="retentionDays"
          required
          step="1"
          type="number"
          @update:model-value="onRetentionInput"
        />
      </UFormField>
    </div>

    <div class="flex items-center gap-2 pt-1">
      <UButton
        color="primary"
        :disabled="!hasChanges || !valid"
        :loading="busy === 'policy'"
        size="sm"
        type="submit"
      >
        Save changes
      </UButton>
      <UButton
        v-if="hasChanges"
        color="neutral"
        size="sm"
        type="button"
        variant="ghost"
        @click="syncFromSnapshot"
      >
        Reset
      </UButton>
    </div>
  </form>
</template>
