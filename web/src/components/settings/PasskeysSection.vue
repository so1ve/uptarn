<script setup lang="ts">
import { ref } from "vue";

import type { PasskeySummary } from "../../lib/index.ts";
import {
  apiFetch,
  formatAge,
  registerPasskey,
  useAction,
  useSnapshot,
} from "../../lib/index.ts";
import ConfirmPopover from "../ui/ConfirmPopover.vue";

const snap = useSnapshot();
const { busy, run } = useAction();
const passkeyName = ref("");

async function onRegisterPasskey() {
  const name = passkeyName.value.trim();
  if (!name) {
    return;
  }
  const ok = await run(
    "passkey",
    "Passkey registration failed",
    async () => {
      await registerPasskey(name);

      return `Passkey "${name}" added`;
    },
    true,
  );
  if (ok) {
    passkeyName.value = "";
  }
}

const onDeletePasskey = (pk: PasskeySummary) =>
  run(
    `del:${pk.id}`,
    "Could not remove passkey",
    async () => {
      await apiFetch(
        `/api/v1/admin/passkeys/${encodeURIComponent(pk.id)}`,
        "DELETE",
      );

      return `Passkey "${pk.name}" removed`;
    },
    true,
  );
</script>

<template>
  <div class="space-y-4">
    <div class="flex flex-wrap items-center gap-2 text-sm">
      <span class="w-20 shrink-0 text-muted">Methods</span>
      <UBadge
        v-for="[name, on] in [
          ['Password', snap.settings.auth.password_enabled],
          ['Cloudflare Access', snap.settings.auth.cf_access_enabled],
        ] as const"
        :key="name"
        :color="on ? 'success' : 'neutral'"
        size="sm"
        variant="subtle"
      >
        {{ name }} {{ on ? "on" : "off" }}
      </UBadge>
    </div>

    <ul
      v-if="snap.passkeys.length > 0"
      class="divide-y divide-default rounded-lg border border-default bg-muted/40"
    >
      <li
        v-for="pk in snap.passkeys"
        :key="pk.id"
        class="flex flex-wrap items-center justify-between gap-3 px-3.5 py-2.5 text-xs"
      >
        <span class="font-medium">{{ pk.name }}</span>
        <div class="flex items-center gap-3">
          <span class="text-dimmed tabular-nums">
            {{
              pk.last_used_at === null
                ? `Added ${formatAge(pk.created_at, snap.now)}`
                : `Used ${formatAge(pk.last_used_at, snap.now)}`
            }}
          </span>
          <ConfirmPopover
            color="error"
            label="Remove"
            :loading="busy === `del:${pk.id}`"
            @confirm="onDeletePasskey(pk)"
          >
            Remove passkey
            <strong>{{ pk.name }}</strong>
            ?
          </ConfirmPopover>
        </div>
      </li>
    </ul>

    <form class="flex items-center gap-2" @submit.prevent="onRegisterPasskey">
      <UInput
        v-model="passkeyName"
        aria-label="Passkey device name"
        class="flex-1"
        placeholder="Device name"
        required
      />
      <UButton
        color="neutral"
        :loading="busy === 'passkey'"
        size="md"
        type="submit"
        variant="soft"
      >
        Add passkey
      </UButton>
    </form>
  </div>
</template>
