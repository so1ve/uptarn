<script setup lang="ts">
import { computed } from "vue";

import CopyField from "../ui/CopyField.vue";

const props = defineProps<{
  issued: { key: string; label: string; pingUrl: string } | null;
}>();

const open = defineModel<boolean>("open", { default: false });

const curlSnippet = computed(() =>
  props.issued ? `curl -fsS -m 10 "${props.issued.pingUrl}"` : "",
);

const wrapperSnippet = computed(() =>
  props.issued
    ? `uptarn-agent run --ping-url "${props.issued.pingUrl}" -- <command>`
    : "",
);
</script>

<template>
  <UModal
    v-model:open="open"
    :title="issued ? `Ping URL for ${issued.label}` : 'Job ping URL'"
  >
    <template #body>
      <div v-if="issued" class="space-y-4">
        <p class="text-sm text-muted">
          Save this URL now. It will not be shown again unless you rotate it.
        </p>

        <CopyField label="Ping URL" :value="issued.pingUrl" />

        <CopyField label="curl (on success)" :value="curlSnippet" />

        <CopyField
          label="uptarn-agent run (tracks start, duration & failure)"
          :value="wrapperSnippet"
        />

        <p class="font-mono text-xs text-dimmed">
          Append
          <code class="text-muted">/start</code>
          or
          <code class="text-muted">/fail</code>
          to report running state or failure logs.
        </p>
      </div>
    </template>

    <template #footer>
      <div class="flex w-full justify-end">
        <UButton color="primary" @click="open = false">Done</UButton>
      </div>
    </template>
  </UModal>
</template>
