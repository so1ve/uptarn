<script setup lang="ts">
import { computed } from "vue";

import type { MonitorSummary } from "../../lib/index.ts";
import { apiFetch, useAction, useModalForm } from "../../lib/index.ts";
import ConfirmPopover from "../ui/ConfirmPopover.vue";

const props = defineProps<{
  monitor: MonitorSummary | null;
}>();

const open = defineModel<boolean>("open", { default: false });

const { busy, run } = useAction();
const methods = ["GET", "HEAD", "POST"];
const isEdit = computed(() => props.monitor !== null);

const form = useModalForm(open, () => {
  const m = props.monitor;
  const hub = m?.probe.from === "hub" ? m.probe : null;

  return {
    id: m?.id ?? "",
    name: m?.name ?? "",
    url: hub?.url ?? "",
    public_url: m?.public_url ?? "",
    method: hub?.method ?? "GET",
    expected_status_min: hub?.expected_status_min ?? 200,
    expected_status_max: hub?.expected_status_max ?? 299,
    expected_body: hub?.expected_body ?? "",
    interval_secs: m?.interval_secs ?? 60,
    timeout_ms: hub?.timeout_ms ?? 8000,
    enabled: m?.enabled ?? true,
    is_public: m?.is_public ?? true,
  };
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
        public_url: form.is_public ? form.public_url.trim() || null : null,
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

        <UFormField
          v-if="form.is_public"
          label="Public link (optional)"
          name="public_url"
        >
          <div class="flex items-center gap-2">
            <UInput
              v-model="form.public_url"
              class="flex-1 font-mono"
              placeholder="Leave empty to hide URL"
              type="url"
            />
            <UButton
              v-if="form.url.trim() && !form.public_url.trim()"
              color="neutral"
              size="xs"
              variant="soft"
              @click="form.public_url = form.url.trim()"
            >
              Use URL
            </UButton>
          </div>
        </UFormField>
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
