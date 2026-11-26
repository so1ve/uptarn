<script setup lang="ts">
import { computed } from "vue";

import type { JobSummary } from "../../lib/index.ts";
import { apiFetch, useAction, useModalForm } from "../../lib/index.ts";

const emit = defineEmits<{
  issued: [payload: { key: string; label: string; pingUrl: string }];
}>();

const props = defineProps<{
  job: JobSummary | null;
}>();

const open = defineModel<boolean>("open", { default: false });

const INTERVAL_PRESETS = [
  { label: "15m", secs: 900 },
  { label: "1h", secs: 3600 },
  { label: "6h", secs: 21_600 },
  { label: "24h", secs: 86_400 },
  { label: "7d", secs: 604_800 },
] as const;

const { busy, run } = useAction();
const isEdit = computed(() => props.job !== null);

const form = useModalForm(open, () => ({
  key: props.job?.key ?? "",
  label: props.job?.label ?? "",
  interval_secs: props.job?.interval_secs ?? 86_400,
  grace_secs: props.job?.grace_secs ?? 3600,
}));

const onSubmit = () =>
  run(
    "save-job",
    isEdit.value ? "Could not update job" : "Could not create job",
    async () => {
      const intervalSecs = Number(form.interval_secs || 86_400);
      const graceSecs = Number(form.grace_secs || 3600);
      if (props.job) {
        await apiFetch(
          `/api/v1/admin/jobs/${encodeURIComponent(props.job.key)}`,
          "PATCH",
          {
            label: form.label.trim(),
            interval_secs: intervalSecs,
            grace_secs: graceSecs,
          },
        );
        open.value = false;

        return `Updated ${form.label.trim()}`;
      }

      const res = await apiFetch<{
        key: string;
        label: string;
        ping_url: string;
      }>("/api/v1/admin/jobs", "POST", {
        key: form.key.trim() || undefined,
        label: form.label.trim(),
        interval_secs: intervalSecs,
        grace_secs: graceSecs,
      });
      open.value = false;
      emit("issued", {
        key: res.key,
        label: res.label,
        pingUrl: res.ping_url,
      });
    },
    true,
  );
</script>

<template>
  <UModal
    v-model:open="open"
    :title="isEdit ? 'Edit push job' : 'Add push job'"
  >
    <template #body>
      <form id="form-job" class="space-y-4" @submit.prevent="onSubmit">
        <UFormField label="Label" name="label" required>
          <UInput
            v-model="form.label"
            autocomplete="off"
            class="w-full"
            placeholder="Nightly Backup"
            required
          />
        </UFormField>

        <UFormField v-if="!isEdit" label="Key (optional)" name="key">
          <UInput
            v-model="form.key"
            autocomplete="off"
            class="w-full font-mono"
            pattern="[A-Za-z0-9][A-Za-z0-9._:\-]{0,63}"
            placeholder="nightly-backup"
          />
        </UFormField>

        <div class="space-y-2">
          <div class="grid grid-cols-2 gap-3">
            <UFormField label="Interval (s)" name="interval_secs" required>
              <UInput
                v-model.number="form.interval_secs"
                class="w-full font-mono"
                :max="2592000"
                :min="30"
                required
                type="number"
              />
            </UFormField>

            <UFormField label="Grace (s)" name="grace_secs" required>
              <UInput
                v-model.number="form.grace_secs"
                class="w-full font-mono"
                :max="604800"
                :min="30"
                required
                type="number"
              />
            </UFormField>
          </div>

          <div class="flex flex-wrap items-center gap-1.5">
            <UButton
              v-for="preset in INTERVAL_PRESETS"
              :key="preset.secs"
              :color="
                form.interval_secs === preset.secs ? 'primary' : 'neutral'
              "
              size="xs"
              type="button"
              :variant="form.interval_secs === preset.secs ? 'soft' : 'ghost'"
              @click="form.interval_secs = preset.secs"
            >
              {{ preset.label }}
            </UButton>
          </div>
        </div>
      </form>
    </template>

    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton color="neutral" variant="ghost" @click="open = false">
          Cancel
        </UButton>
        <UButton
          color="primary"
          form="form-job"
          :loading="busy === 'save-job'"
          type="submit"
        >
          {{ isEdit ? "Save changes" : "Create job" }}
        </UButton>
      </div>
    </template>
  </UModal>
</template>
