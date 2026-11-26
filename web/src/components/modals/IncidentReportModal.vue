<script setup lang="ts">
import { computed } from "vue";

import type {
  IncidentReportImpact,
  IncidentReportSummary,
  MaintenanceTarget,
} from "../../lib/index.ts";
import {
  apiFetch,
  useAction,
  useModalForm,
  useSnapshot,
} from "../../lib/index.ts";
import ConfirmPopover from "../ui/ConfirmPopover.vue";
import DateTimePicker from "../ui/DateTimePicker.vue";
import SegmentedControl from "../ui/SegmentedControl.vue";

const props = defineProps<{
  report: IncidentReportSummary | null;
}>();

const open = defineModel<boolean>("open", { default: false });

const snap = useSnapshot();
const { busy, run } = useAction();

const isEdit = computed(() => props.report !== null);

const IMPACT_OPTIONS: readonly {
  value: IncidentReportImpact;
  label: string;
}[] = [
  { value: "minor", label: "Minor" },
  { value: "major", label: "Major" },
];

const SCOPE_OPTIONS = [
  { value: "all" as const, label: "General" },
  { value: "selected" as const, label: "Specific targets" },
];

const form = useModalForm(open, () => {
  const r = props.report;

  return {
    id: r?.id ?? "",
    title: r?.title ?? "",
    impact: r?.impact ?? "minor",
    is_public: r ? r.is_public : true,
    started_at: r ? r.created_at : (null as number | null),
    message: "",
    scope: r && r.targets.length > 0 ? ("selected" as const) : ("all" as const),
    selectedKeys: new Set<string>(
      (r?.targets ?? []).map((t) => `${t.type}:${t.id}`),
    ),
  };
});

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
    "Could not save incident",
    async () => {
      if (form.scope === "selected" && targets.length === 0) {
        throw new Error("Select at least one target, or switch to General");
      }
      await apiFetch("/api/v1/admin/incident-reports", "POST", {
        id: form.id.trim() || undefined,
        title: form.title.trim(),
        status: props.report?.status ?? "investigating",
        impact: form.impact,
        is_public: form.is_public,
        created_at: form.started_at ?? undefined,
        message: form.message.trim() || undefined,
        targets,
      });

      return isEdit.value ? "Incident saved" : "Incident created";
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
        `/api/v1/admin/incident-reports/${encodeURIComponent(form.id)}`,
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
    :title="isEdit ? 'Edit incident' : 'New incident'"
  >
    <template #body>
      <form
        id="form-incident-report"
        class="space-y-4"
        @submit.prevent="onSubmit"
      >
        <UFormField label="Title" name="title" required>
          <UInput
            v-model="form.title"
            class="w-full"
            :maxlength="100"
            placeholder="Upstream packet loss in EU"
            required
          />
        </UFormField>

        <UFormField
          v-if="!isEdit"
          label="Initial update (optional)"
          name="message"
        >
          <UTextarea
            v-model="form.message"
            class="w-full"
            :maxlength="1000"
            placeholder="What is happening right now? You can add or edit updates on the timeline anytime."
            :rows="3"
          />
        </UFormField>

        <div class="space-y-2.5">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <span class="text-xs font-medium text-default">Impact</span>
            <SegmentedControl
              v-model="form.impact"
              aria-label="Incident impact"
              :options="IMPACT_OPTIONS"
            />
          </div>

          <div class="flex items-center justify-between gap-2">
            <span class="text-xs font-medium text-default">
              Show on public status page
            </span>
            <USwitch
              v-model="form.is_public"
              aria-label="Show on public status page"
            />
          </div>

          <div class="flex flex-wrap items-center justify-between gap-2">
            <span class="text-xs font-medium text-default">
              Started at (optional)
            </span>
            <DateTimePicker
              v-model="form.started_at"
              aria-label="Incident start time"
              clearable
              size="sm"
            />
          </div>
        </div>

        <div class="space-y-2.5">
          <div class="flex items-center justify-between gap-2">
            <span class="text-xs font-medium text-default">Affected</span>
            <SegmentedControl
              v-model="form.scope"
              aria-label="Affected targets scope"
              :options="SCOPE_OPTIONS"
            />
          </div>

          <div
            v-if="form.scope === 'selected'"
            class="max-h-44 space-y-3 overflow-y-auto rounded-lg border border-default p-3"
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
                  <UBadge
                    v-if="!mon.is_public"
                    class="shrink-0"
                    color="neutral"
                    size="xs"
                    variant="subtle"
                  >
                    Private
                  </UBadge>
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
                  <UBadge
                    v-if="!node.is_public"
                    class="shrink-0"
                    color="neutral"
                    size="xs"
                    variant="subtle"
                  >
                    Private
                  </UBadge>
                </div>
              </div>
            </div>
          </div>
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
            label="Delete"
            :loading="busy === 'delete'"
            size="sm"
            @confirm="onDelete"
          >
            Delete incident
            <strong>{{ props.report?.title }}</strong>
            ?
          </ConfirmPopover>
        </div>
        <div class="flex items-center gap-2">
          <UButton color="neutral" variant="ghost" @click="open = false">
            Cancel
          </UButton>
          <UButton
            color="primary"
            form="form-incident-report"
            :loading="busy === 'save'"
            type="submit"
          >
            {{ isEdit ? "Save" : "Create" }}
          </UButton>
        </div>
      </div>
    </template>
  </UModal>
</template>
