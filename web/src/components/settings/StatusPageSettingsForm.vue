<script setup lang="ts">
import { computed, ref, watch } from "vue";

import type { SiteLink } from "../../lib/index.ts";
import { apiFetch, useAction, useSnapshot } from "../../lib/index.ts";
import SiteLinkRow from "./SiteLinkRow.vue";

const MAX_LINKS = 6;

const snap = useSnapshot();
const { busy, run } = useAction();

const siteTitle = ref("");
const siteLinks = ref<SiteLink[]>([]);
const dirty = ref(false);

function syncFromSnapshot() {
  siteTitle.value = snap.value.settings.site_title ?? "";
  siteLinks.value = snap.value.settings.site_links.map((l) => ({ ...l }));
  dirty.value = false;
}

watch(
  () => [snap.value.settings.site_title, snap.value.settings.site_links],
  () => {
    if (!dirty.value) {
      syncFromSnapshot();
    }
  },
  { immediate: true, deep: true },
);

const normalizedLinks = computed(() =>
  siteLinks.value
    .map((l) => ({ label: l.label.trim(), url: l.url.trim() }))
    .filter((l) => l.label.length > 0 || l.url.length > 0),
);

const hasChanges = computed(() => {
  const nextTitle = siteTitle.value.trim() || null;

  return (
    nextTitle !== snap.value.settings.site_title ||
    JSON.stringify(normalizedLinks.value) !==
      JSON.stringify(snap.value.settings.site_links)
  );
});

function setTitle(val: string | number) {
  siteTitle.value = String(val);
  dirty.value = true;
}

function setLinkField(index: number, field: keyof SiteLink, val: string) {
  const row = siteLinks.value[index];
  if (!row) {
    return;
  }
  row[field] = val;
  dirty.value = true;
}

function addLink() {
  if (siteLinks.value.length >= MAX_LINKS) {
    return;
  }
  siteLinks.value.push({ label: "", url: "" });
  dirty.value = true;
}

function removeLink(index: number) {
  siteLinks.value.splice(index, 1);
  dirty.value = true;
}

async function onSubmit() {
  const ok = await run(
    "branding",
    "Could not save status page settings",
    async () => {
      await apiFetch("/api/v1/admin/settings", "PATCH", {
        site_title: siteTitle.value.trim() || null,
        site_links: normalizedLinks.value,
      });

      return "Status page settings saved";
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
    <UFormField class="max-w-md" label="Title" name="site_title">
      <UInput
        class="w-full"
        :maxlength="60"
        :model-value="siteTitle"
        placeholder="Uptarn"
        @update:model-value="setTitle"
      />
    </UFormField>

    <div class="space-y-2.5">
      <div class="flex items-center justify-between gap-2">
        <span class="text-xs font-medium text-default">Navigation links</span>
        <UButton
          v-if="siteLinks.length < MAX_LINKS"
          color="neutral"
          icon="i-lucide-plus"
          size="xs"
          type="button"
          variant="soft"
          @click="addLink"
        >
          Add link
        </UButton>
      </div>

      <div v-if="siteLinks.length > 0" class="space-y-2">
        <SiteLinkRow
          v-for="(link, idx) in siteLinks"
          :key="idx"
          :link
          @remove="removeLink(idx)"
          @update="(field, value) => setLinkField(idx, field, value)"
        />
      </div>
      <p v-else class="text-xs text-dimmed">No external links configured.</p>
    </div>

    <div class="flex items-center gap-2 pt-1">
      <UButton
        color="primary"
        :disabled="!hasChanges"
        :loading="busy === 'branding'"
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
