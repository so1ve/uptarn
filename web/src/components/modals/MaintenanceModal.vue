<script setup lang="ts">
import { computed } from "vue";

import type { MaintenanceSummary, MaintenanceTarget } from "../../lib/index.ts";
import {
  apiFetch,
  useAction,
  useModalForm,
  useSnapshot,
} from "../../lib/index.ts";
import ConfirmPopover from "../ui/ConfirmPopover.vue";
import DateTimePicker from "../ui/DateTimePicker.vue";
import PrivateIcon from "../ui/PrivateIcon.vue";
import SegmentedControl from "../ui/SegmentedControl.vue";

const props = defineProps<{
  maintenance: MaintenanceSummary | null;
}>();

const open = defineModel<boolean>("open", { default: false });

const snap = useSnapshot();
const { busy, run } = useAction();

const isEdit = computed(() => props.maintenance !== null);
const SCOPE_OPTIONS = [
  { value: "all" as const, label: "All targets" },
  { value: "selected" as const, label: "Specific targets" },
];
const DURATION_PRESETS = [
  { label: "+1h", secs: 3600 },
  { label: "+2h", secs: 7200 },
  { label: "+4h", secs: 14_400 },
] as const;

const form = useModalForm(open, () => {
  const m = props.maintenance;
  const defaultStart = Math.ceil(snap.value.now / 300) * 300;
  const defaultEnd = defaultStart + 3600;

  return {
    id: m?.id ?? "",
    title: m?.title ?? "",
    body: m?.body ?? "",
    starts_at: m?.starts_at ?? defaultStart,
    ends_at: m?.ends_at ?? defaultEnd,
    scope: m && m.targets.length > 0 ? "selected" : "all",
    selectedKeys: new Set<string>(
      (m?.targets ?? []).map((t) => `${t.type}:${t.id}`),
    ),
  };
});

function applyDuration(secs: number) {
  const start = form.starts_at ?? snap.value.now;
  form.ends_at = start + secs;
}

function setTarget(type: "monitor" | "node", id: string, checked: boolean) {
  const key = `${type}:${id}`;
  if (checked) {
    form.selectedKeys.add(key);
  } else {
    form.selectedKeys.delete(key);
  }
}

async function onSubmit() {
  const targets: MaintenanceTarget[] =
    form.scope === "all"
      ? []
      : [...form.selectedKeys].map((key) => {
          const sep = key.indexOf(":");

          return {
            type: key.slice(0, sep) as "monitor" | "node",
            id: key.slice(sep + 1),
          };
        });

  const ok = await run(
    "save",
    "Could not save maintenance",
    async () => {
      if (form.starts_at === null || form.ends_at === null) {
        throw new Error("Start and end times are required");
      }
      if (form.scope === "selected" && targets.length === 0) {
        throw new Error("Select at least one target, or switch to All targets");
      }
      await apiFetch("/api/v1/admin/maintenances", "POST", {
        id: form.id.trim() || undefined,
        title: form.title.trim(),
        body: form.body.trim(),
        starts_at: form.starts_at,
        ends_at: form.ends_at,
        targets,
      });

      return isEdit.value ? "Maintenance updated" : "Maintenance scheduled";
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
        `/api/v1/admin/maintenances/${encodeURIComponent(form.id)}`,
        "DELETE",
      );

      return `Deleted "${form.title}"`;
    },
    true,
  );
  if (ok) {
    open.value = false;
  }
}
</script>

<template>
  <UModal
    v-model:open="open"
    :title="isEdit ? 'Edit maintenance' : 'Schedule maintenance'"
  >
    <template #body>
      <form id="form-maintenance" class="space-y-4" @submit.prevent="onSubmit">
        <UFormField label="Title" name="title" required>
          <UInput
            v-model="form.title"
            class="w-full"
            :maxlength="100"
            placeholder="Database upgrade"
            required
          />
        </UFormField>

        <div class="space-y-2">
          <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <UFormField label="Starts" name="starts_at" required>
              <DateTimePicker
                v-model="form.starts_at"
                aria-label="Maintenance start time"
                class="w-full"
                size="md"
              />
            </UFormField>
            <UFormField label="Ends" name="ends_at" required>
              <DateTimePicker
                v-model="form.ends_at"
                aria-label="Maintenance end time"
                class="w-full"
                size="md"
              />
            </UFormField>
          </div>
          <div class="flex items-center gap-1.5">
            <span class="text-xs text-muted">Duration</span>
            <UButton
              v-for="p in DURATION_PRESETS"
              :key="p.secs"
              color="neutral"
              size="xs"
              type="button"
              variant="soft"
              @click="applyDuration(p.secs)"
            >
              {{ p.label }}
            </UButton>
          </div>
        </div>

        <div class="space-y-2.5">
          <div class="flex items-center justify-between gap-2">
            <span class="text-xs font-medium text-default">Scope</span>
            <SegmentedControl
              v-model="form.scope"
              aria-label="Maintenance scope"
              :options="SCOPE_OPTIONS"
            />
          </div>

          <div
            v-if="form.scope === 'selected'"
            class="max-h-48 space-y-3 overflow-y-auto rounded-lg border border-default p-3"
          >
            <div v-if="snap.monitors.length > 0" class="space-y-1.5">
              <div class="text-xs font-medium text-muted">Monitors</div>
              <div class="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                <div
                  v-for="mon in snap.monitors"
                  :key="mon.id"
                  class="flex items-center gap-2 rounded px-1.5 py-1 hover:bg-elevated"
                >
                  <UCheckbox
                    class="min-w-0 flex-1"
                    :label="mon.name"
                    :model-value="form.selectedKeys.has(`monitor:${mon.id}`)"
                    size="xs"
                    @update:model-value="
                      (v) => setTarget('monitor', mon.id, v === true)
                    "
                  />
                  <PrivateIcon v-if="!mon.is_public" />
                </div>
              </div>
            </div>

            <div v-if="snap.nodes.length > 0" class="space-y-1.5">
              <div class="text-xs font-medium text-muted">Nodes</div>
              <div class="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                <div
                  v-for="node in snap.nodes"
                  :key="node.id"
                  class="flex items-center gap-2 rounded px-1.5 py-1 hover:bg-elevated"
                >
                  <UCheckbox
                    class="min-w-0 flex-1"
                    :label="node.label"
                    :model-value="form.selectedKeys.has(`node:${node.id}`)"
                    size="xs"
                    @update:model-value="
                      (v) => setTarget('node', node.id, v === true)
                    "
                  />
                  <PrivateIcon v-if="!node.is_public" />
                </div>
              </div>
            </div>
          </div>
        </div>

        <UFormField label="Notes (optional)" name="body">
          <UTextarea
            v-model="form.body"
            class="w-full"
            :maxlength="1000"
            placeholder="Expected brief interruption while upgrading."
            :rows="3"
          />
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
            label="Delete"
            :loading="busy === 'delete'"
            size="sm"
            @confirm="onDelete"
          >
            Delete maintenance
            <strong>{{ props.maintenance?.title }}</strong>
            ?
          </ConfirmPopover>
        </div>
        <div class="flex items-center gap-2">
          <UButton color="neutral" variant="ghost" @click="open = false">
            Cancel
          </UButton>
          <UButton
            color="primary"
            form="form-maintenance"
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
