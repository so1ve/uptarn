<script setup lang="ts">
import { computed, reactive, ref } from "vue";

import type { IncidentReportStatus, TimelineEntry } from "../../lib/index.ts";
import { formatAge, formatTimestamp } from "../../lib/index.ts";
import DateTimePicker from "../ui/DateTimePicker.vue";

const emit = defineEmits<{
  add: [
    payload: {
      message: string;
      status: IncidentReportStatus | null;
      isPublic: boolean;
    },
  ];
  edit: [
    payload: {
      id: string;
      message: string;
      status: IncidentReportStatus | null;
      createdAt: number;
      isPublic?: boolean;
    },
  ];
  delete: [id: string];
}>();

const props = withDefaults(
  defineProps<{
    entries: readonly TimelineEntry[];
    now: number;
    canAdd?: boolean;
    showPublicToggle?: boolean;
    allowResolveStatus?: boolean;
    busyKey?: string | null;
  }>(),
  {
    canAdd: false,
    showPublicToggle: false,
    allowResolveStatus: false,
    busyKey: null,
  },
);

type TagValue = "update" | IncidentReportStatus;

const DOT_CLASS: Record<TimelineEntry["tone"], string> = {
  ok: "bg-emerald-500",
  warn: "bg-amber-500",
  fail: "bg-red-500",
  info: "bg-sky-500",
  neutral: "bg-zinc-400 dark:bg-zinc-500",
};

const LABEL_CLASS: Record<TimelineEntry["tone"], string> = {
  ok: "text-emerald-600 dark:text-emerald-400",
  warn: "text-amber-600 dark:text-amber-400",
  fail: "text-red-600 dark:text-red-400",
  info: "text-sky-600 dark:text-sky-400",
  neutral: "text-default",
};

const ALL_TAG_ITEMS: {
  value: TagValue;
  label: string;
  chip: { color: "neutral" | "warning" | "info" | "success" };
}[] = [
  { value: "update", label: "Update", chip: { color: "neutral" } },
  {
    value: "investigating",
    label: "Investigating",
    chip: { color: "warning" },
  },
  { value: "identified", label: "Identified", chip: { color: "warning" } },
  { value: "monitoring", label: "Monitoring", chip: { color: "info" } },
  { value: "resolved", label: "Resolved", chip: { color: "success" } },
];

const composerTagItems = computed(() =>
  props.allowResolveStatus
    ? ALL_TAG_ITEMS
    : ALL_TAG_ITEMS.filter((o) => o.value !== "resolved"),
);

// Inline composer state
const composerMessage = ref("");
const composerTag = ref<TagValue>("update");
const composerPublic = ref(true);

function onAddSubmit() {
  const message = composerMessage.value.trim();
  if (!message) {
    return;
  }
  const status: IncidentReportStatus | null =
    composerTag.value === "update" ? null : composerTag.value;
  emit("add", {
    message,
    status,
    isPublic: composerPublic.value,
  });
  composerMessage.value = "";
  composerTag.value = "update";
}

// Inline edit & delete confirm state for an existing entry
const editingId = ref<string | null>(null);
const deletingId = ref<string | null>(null);

function confirmDelete(id: string) {
  deletingId.value = null;
  emit("delete", id);
}
const editDraft = reactive<{
  message: string;
  tag: TagValue;
  timestamp: number | null;
  originalTs: number;
  isPublic: boolean;
}>({
  message: "",
  tag: "update",
  timestamp: null,
  originalTs: 0,
  isPublic: true,
});

function startEdit(entry: TimelineEntry) {
  if (!entry.editId) {
    return;
  }
  editingId.value = entry.editId;
  editDraft.message = entry.message;
  editDraft.tag = entry.status ?? "update";
  editDraft.timestamp = entry.timestamp;
  editDraft.originalTs = entry.timestamp;
  editDraft.isPublic = entry.isPublic ?? true;
}

function saveEdit() {
  if (!editingId.value || !editDraft.message.trim()) {
    return;
  }
  const status: IncidentReportStatus | null =
    editDraft.tag === "update" ? null : editDraft.tag;
  emit("edit", {
    id: editingId.value,
    message: editDraft.message.trim(),
    status,
    createdAt: editDraft.timestamp ?? editDraft.originalTs,
    isPublic: props.showPublicToggle ? editDraft.isPublic : undefined,
  });
  editingId.value = null;
}
</script>

<template>
  <div class="space-y-3">
    <form
      v-if="canAdd"
      class="flex flex-wrap items-center gap-2"
      @submit.prevent="onAddSubmit"
    >
      <UInput
        v-model="composerMessage"
        aria-label="Add timeline update"
        class="min-w-48 flex-1"
        :maxlength="1000"
        placeholder="Add an update..."
        size="xs"
      />
      <USelect
        v-model="composerTag"
        aria-label="Update label"
        class="w-32"
        :items="composerTagItems"
        size="xs"
      />
      <UCheckbox
        v-if="showPublicToggle"
        v-model="composerPublic"
        label="Public"
        size="xs"
      />
      <UButton
        color="primary"
        :disabled="!composerMessage.trim()"
        :loading="busyKey === 'add'"
        size="xs"
        type="submit"
      >
        Post
      </UButton>
    </form>

    <ol
      v-if="entries.length > 0"
      class="relative ml-2 space-y-3 border-l border-default py-0.5 pl-4"
    >
      <li v-for="entry in entries" :key="entry.key" class="group/item relative">
        <span
          aria-hidden="true"
          class="absolute top-1.5 -left-[20.5px] size-2 rounded-full ring-2 ring-default"
          :class="DOT_CLASS[entry.tone]"
        />

        <form
          v-if="entry.editId && editingId === entry.editId"
          class="space-y-2.5 rounded-lg border border-default bg-surface p-2.5"
          @submit.prevent="saveEdit"
        >
          <UTextarea
            v-model="editDraft.message"
            aria-label="Edit timeline message"
            class="w-full"
            :maxlength="1000"
            required
            :rows="2"
          />
          <div class="flex flex-wrap items-center justify-between gap-2">
            <div class="flex flex-wrap items-center gap-2">
              <USelect
                v-model="editDraft.tag"
                aria-label="Edit update label"
                class="w-32"
                :items="ALL_TAG_ITEMS"
                size="xs"
              />
              <DateTimePicker
                v-model="editDraft.timestamp"
                aria-label="Edit update timestamp"
                size="xs"
              />
              <UCheckbox
                v-if="showPublicToggle"
                v-model="editDraft.isPublic"
                label="Public"
                size="xs"
              />
            </div>
            <div class="flex items-center gap-1.5">
              <UButton
                color="neutral"
                size="xs"
                type="button"
                variant="ghost"
                @click="editingId = null"
              >
                Cancel
              </UButton>
              <UButton
                color="primary"
                :disabled="!editDraft.message.trim()"
                :loading="busyKey === `edit:${entry.editId}`"
                size="xs"
                type="submit"
              >
                Save
              </UButton>
            </div>
          </div>
        </form>

        <template v-else>
          <div
            class="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5"
          >
            <span class="text-xs font-medium" :class="LABEL_CLASS[entry.tone]">
              {{ entry.label }}
            </span>
            <div class="flex items-center gap-1.5">
              <template v-if="entry.editId">
                <UTooltip text="Edit">
                  <button
                    aria-label="Edit update"
                    class="inline-flex size-5 cursor-pointer items-center justify-center rounded text-dimmed transition-colors hover:bg-elevated hover:text-default focus-visible:outline-2 focus-visible:outline-primary"
                    type="button"
                    @click="startEdit(entry)"
                  >
                    <UIcon class="size-3" name="i-lucide-pencil" />
                  </button>
                </UTooltip>
                <UPopover
                  :open="deletingId === entry.editId"
                  @update:open="
                    (v) => (deletingId = v ? (entry.editId ?? null) : null)
                  "
                >
                  <UTooltip text="Delete">
                    <button
                      aria-label="Delete update"
                      class="inline-flex size-5 cursor-pointer items-center justify-center rounded text-dimmed transition-colors hover:bg-elevated hover:text-red-500 focus-visible:outline-2 focus-visible:outline-primary disabled:pointer-events-none disabled:opacity-50"
                      :disabled="busyKey === `del:${entry.editId}`"
                      type="button"
                    >
                      <UIcon class="size-3" name="i-lucide-trash-2" />
                    </button>
                  </UTooltip>
                  <template #content>
                    <div class="w-48 space-y-2.5 p-3 text-xs">
                      <p class="leading-relaxed text-default">
                        Delete this update?
                      </p>
                      <div class="flex justify-end gap-1.5">
                        <UButton
                          color="neutral"
                          size="xs"
                          variant="ghost"
                          @click="deletingId = null"
                        >
                          Cancel
                        </UButton>
                        <UButton
                          color="error"
                          size="xs"
                          @click="confirmDelete(entry.editId)"
                        >
                          Delete
                        </UButton>
                      </div>
                    </div>
                  </template>
                </UPopover>
              </template>
              <UTooltip :text="formatTimestamp(entry.timestamp, true)">
                <span class="font-mono text-[11px] text-dimmed tabular-nums">
                  {{ formatAge(entry.timestamp, now) }}
                </span>
              </UTooltip>
            </div>
          </div>
          <p
            v-if="entry.message"
            class="mt-0.5 text-xs leading-relaxed whitespace-pre-line text-muted"
          >
            {{ entry.message }}
          </p>
          <p
            v-if="entry.meta"
            class="mt-0.5 font-mono text-[11px] whitespace-pre-line"
            :class="
              entry.metaWarn
                ? 'text-amber-600 dark:text-amber-400'
                : 'text-dimmed'
            "
          >
            {{ entry.meta }}
          </p>
        </template>
      </li>
    </ol>
  </div>
</template>
