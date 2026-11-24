<script setup lang="ts">
import { computed, reactive, watch } from "vue";

import type { MonitorSummary } from "../../lib/index.ts";
import { apiFetch, useAction } from "../../lib/index.ts";
import ConfirmPopover from "../ui/ConfirmPopover.vue";

const props = defineProps<{
  monitor: MonitorSummary | null;
}>();

const open = defineModel<boolean>("open", { default: false });

const { busy, run } = useAction();
const methods = ["GET", "HEAD", "POST"];

const form = reactive({
  id: "",
  name: "",
  url: "",
  method: "GET",
  expected_status_min: 200,
  expected_status_max: 299,
  expected_body: "",
  interval_secs: 60,
  timeout_ms: 8000,
  enabled: true,
  is_public: true,
});

const isEdit = computed(() => props.monitor !== null);

watch(open, (isOpen) => {
  if (!isOpen) {
    return;
  }
  const m = props.monitor;
  Object.assign(form, {
    id: m?.id ?? "",
    name: m?.name ?? "",
    url: m?.url ?? "",
    method: m?.method ?? "GET",
    expected_status_min: m?.expected_status_min ?? 200,
    expected_status_max: m?.expected_status_max ?? 299,
    expected_body: m?.expected_body ?? "",
    interval_secs: m?.interval_secs ?? 60,
    timeout_ms: m?.timeout_ms ?? 8000,
    enabled: m ? Boolean(m.enabled) : true,
    is_public: m ? Boolean(m.is_public) : true,
  });
});

async function onSubmit() {
  const ok = await run(
    "save",
    "Could not save monitor",
    async () => {
      await apiFetch("/api/v1/admin/monitors", "POST", {
        id: form.id.trim() || undefined,
        name: form.name.trim(),
        url: form.url.trim(),
        method: form.method,
        expected_status_min: Number(form.expected_status_min || 200),
        expected_status_max: Number(form.expected_status_max || 299),
        expected_body: form.expected_body.trim() || null,
        interval_secs: Number(form.interval_secs || 60),
        timeout_ms: Number(form.timeout_ms || 8000),
        enabled: form.enabled,
        is_public: form.is_public,
      });

      return isEdit.value ? "Monitor updated" : "Monitor added";
    },
    true,
  );
  if (ok) {
    open.value = false;
  }
}

async function onDelete() {
  if (!form.id) {
    return;
  }
  const ok = await run(
    "delete",
    "Delete failed",
    async () => {
      await apiFetch(
        `/api/v1/admin/monitors/${encodeURIComponent(form.id)}`,
        "DELETE",
      );

      return `Deleted ${form.name}`;
    },
    true,
  );
  if (ok) {
    open.value = false;
  }
}
</script>

<template>
  <UModal v-model:open="open" :title="isEdit ? 'Edit monitor' : 'Add monitor'">
    <template #body>
      <form id="form-monitor" class="space-y-4" @submit.prevent="onSubmit">
        <UFormField label="Name" name="name" required>
          <UInput v-model="form.name" class="w-full" required />
        </UFormField>

        <UFormField label="URL" name="url" required>
          <UInput
            v-model="form.url"
            class="w-full font-mono"
            placeholder="https://example.com/healthz"
            required
            type="url"
          />
        </UFormField>

        <div class="grid grid-cols-3 gap-3">
          <UFormField label="Method" name="method">
            <USelect
              v-model="form.method"
              class="w-full font-mono"
              :items="methods"
            />
          </UFormField>
          <UFormField label="Status from" name="expected_status_min" required>
            <UInput
              v-model.number="form.expected_status_min"
              class="w-full font-mono"
              :max="599"
              :min="100"
              required
              type="number"
            />
          </UFormField>
          <UFormField label="Status to" name="expected_status_max" required>
            <UInput
              v-model.number="form.expected_status_max"
              class="w-full font-mono"
              :max="599"
              :min="100"
              required
              type="number"
            />
          </UFormField>
        </div>

        <UFormField label="Response must contain" name="expected_body">
          <UInput v-model="form.expected_body" class="w-full font-mono" />
        </UFormField>

        <div class="grid grid-cols-2 gap-3">
          <UFormField label="Interval (s)" name="interval_secs" required>
            <UInput
              v-model.number="form.interval_secs"
              class="w-full font-mono"
              :max="86400"
              :min="30"
              required
              type="number"
            />
          </UFormField>
          <UFormField label="Timeout (ms)" name="timeout_ms" required>
            <UInput
              v-model.number="form.timeout_ms"
              class="w-full font-mono"
              :max="30000"
              :min="500"
              required
              type="number"
            />
          </UFormField>
        </div>

        <div class="flex flex-wrap items-center gap-6">
          <USwitch v-model="form.enabled" label="Enabled" />
          <USwitch v-model="form.is_public" label="Show on status page" />
        </div>
      </form>
    </template>

    <template #footer>
      <div class="flex w-full items-center justify-between gap-2">
        <div>
          <ConfirmPopover
            v-if="isEdit"
            color="error"
            confirm-label="Delete"
            label="Delete monitor"
            :loading="busy === 'delete'"
            size="sm"
            @confirm="onDelete"
          >
            Delete
            <strong>{{ props.monitor?.name }}</strong>
            and its history?
          </ConfirmPopover>
        </div>
        <div class="flex items-center gap-2">
          <UButton color="neutral" variant="ghost" @click="open = false">
            Cancel
          </UButton>
          <UButton
            color="primary"
            form="form-monitor"
            :loading="busy === 'save'"
            type="submit"
          >
            Save
          </UButton>
        </div>
      </div>
    </template>
  </UModal>
</template>
