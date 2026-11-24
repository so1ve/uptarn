<script setup lang="ts">
import { reactive, watch } from "vue";

import { apiFetch, useAction, useUptarnStore } from "../../lib/index.ts";

const open = defineModel<boolean>("open", { default: false });

const { busy, run } = useAction();
const { showIssuedToken } = useUptarnStore();

const form = reactive({
  id: "",
  label: "",
  interval_secs: 60,
  grace_secs: 120,
  is_public: false,
});

watch(open, (isOpen) => {
  if (isOpen) {
    Object.assign(form, {
      id: "",
      label: "",
      interval_secs: 60,
      grace_secs: 120,
      is_public: false,
    });
  }
});

const onSubmit = () =>
  run("create", "Could not create node", async () => {
    const intervalSecs = Number(form.interval_secs || 60);
    const graceSecs = Number(form.grace_secs || 120);
    const res = await apiFetch<{ id: string; token: string }>(
      "/api/v1/admin/nodes",
      "POST",
      {
        id: form.id.trim(),
        label: form.label.trim() || undefined,
        interval_secs: intervalSecs,
        grace_secs: graceSecs,
        is_public: form.is_public,
      },
    );
    open.value = false;
    showIssuedToken({ ...res, intervalSecs, graceSecs });
  });
</script>

<template>
  <UModal v-model:open="open" title="Add node">
    <template #body>
      <form id="form-add-node" class="space-y-4" @submit.prevent="onSubmit">
        <UFormField label="Node ID" name="id" required>
          <UInput
            v-model="form.id"
            autocomplete="off"
            class="w-full font-mono"
            pattern="[A-Za-z0-9][A-Za-z0-9._:\-]{0,63}"
            placeholder="homelab"
            required
          />
        </UFormField>

        <UFormField label="Display name" name="label">
          <UInput v-model="form.label" class="w-full" />
        </UFormField>

        <div class="grid grid-cols-2 gap-3">
          <UFormField label="Report interval (s)" name="interval_secs" required>
            <UInput
              v-model.number="form.interval_secs"
              class="w-full font-mono"
              :max="86400"
              :min="10"
              required
              type="number"
            />
          </UFormField>

          <UFormField label="Grace period (s)" name="grace_secs" required>
            <UInput
              v-model.number="form.grace_secs"
              class="w-full font-mono"
              :max="604800"
              :min="10"
              required
              type="number"
            />
          </UFormField>
        </div>

        <USwitch v-model="form.is_public" label="Show on status page" />
      </form>
    </template>

    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton color="neutral" variant="ghost" @click="open = false">
          Cancel
        </UButton>
        <UButton
          color="primary"
          form="form-add-node"
          :loading="busy === 'create'"
          type="submit"
        >
          Create node
        </UButton>
      </div>
    </template>
  </UModal>
</template>
