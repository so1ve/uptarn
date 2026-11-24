<script setup lang="ts">
import { computed } from "vue";

import { useAction, useSnapshot, useUptarnStore } from "../../lib/index.ts";

const snap = useSnapshot();
const { copy } = useAction();
const { issuedToken, tokenModalOpen } = useUptarnStore();

const agentConfigSnippet = computed(() => {
  if (!issuedToken.value) {
    return "";
  }
  const node = snap.value.nodes.find((n) => n.id === issuedToken.value?.id);
  const intervalSecs =
    issuedToken.value.intervalSecs ?? node?.interval_secs ?? 60;
  const graceSecs = issuedToken.value.graceSecs ?? node?.grace_secs ?? 120;
  const lines = [
    `hub_url = "${snap.value.public_base_url}"`,
    `node_id = "${issuedToken.value.id}"`,
    `token = "${issuedToken.value.token}"`,
    `interval_secs = ${intervalSecs}`,
  ];
  if (graceSecs !== 120) {
    lines.push(`grace_secs = ${graceSecs}`);
  }

  return lines.join("\n");
});
</script>

<template>
  <UModal
    v-model:open="tokenModalOpen"
    :title="issuedToken ? `Token for ${issuedToken.id}` : 'Node token'"
  >
    <template #body>
      <div v-if="issuedToken" class="space-y-4">
        <p class="text-sm text-muted">
          Save this token now. It will not be shown again.
        </p>

        <UFormField label="Token">
          <div class="flex items-center gap-2">
            <UInput
              class="flex-1 font-mono"
              :model-value="issuedToken.token"
              readonly
            />
            <UButton
              color="neutral"
              icon="i-lucide-copy"
              size="sm"
              variant="soft"
              @click="copy(issuedToken.token, 'Token')"
            >
              Copy
            </UButton>
          </div>
        </UFormField>

        <UFormField label="agent.toml">
          <div class="space-y-2">
            <UTextarea
              class="w-full font-mono"
              :model-value="agentConfigSnippet"
              readonly
              :rows="5"
            />
            <div class="flex justify-end">
              <UButton
                color="neutral"
                icon="i-lucide-copy"
                size="xs"
                variant="soft"
                @click="copy(agentConfigSnippet, 'agent.toml')"
              >
                Copy snippet
              </UButton>
            </div>
          </div>
        </UFormField>
      </div>
    </template>

    <template #footer>
      <div class="flex w-full justify-end">
        <UButton color="primary" @click="tokenModalOpen = false">Done</UButton>
      </div>
    </template>
  </UModal>
</template>
