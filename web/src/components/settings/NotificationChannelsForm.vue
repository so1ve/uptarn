<script setup lang="ts">
import { computed, ref, watch } from "vue";

import type { NotificationChannelName, SecretSource } from "../../lib/index.ts";
import { apiFetch, useAction, useSnapshot } from "../../lib/index.ts";
import SecretSourceHint from "./SecretSourceHint.vue";

interface HeaderRow {
  name: string;
  value: string;
}

const MAX_HEADERS = 16;

const snap = useSnapshot();
const toast = useToast();
const { busy, run } = useAction();

const expanded = ref<NotificationChannelName | null>(null);

const telegram = ref({
  enabled: false,
  chatId: "",
  botToken: "",
  clearToken: false,
  dirty: false,
});

const matrix = ref({
  enabled: false,
  homeserver: "",
  roomId: "",
  accessToken: "",
  clearToken: false,
  dirty: false,
});

const webhook = ref({
  enabled: false,
  url: "",
  secret: "",
  clearSecret: false,
  headers: [] as HeaderRow[],
  dirty: false,
});

const notifications = computed(() => snap.value.settings.notifications);

function syncTelegram() {
  const s = notifications.value.telegram;
  telegram.value = {
    enabled: s.enabled,
    chatId: s.chat_id ?? "",
    botToken: "",
    clearToken: false,
    dirty: false,
  };
}

function syncMatrix() {
  const s = notifications.value.matrix;
  matrix.value = {
    enabled: s.enabled,
    homeserver: s.homeserver ?? "",
    roomId: s.room_id ?? "",
    accessToken: "",
    clearToken: false,
    dirty: false,
  };
}

function syncWebhook() {
  const s = notifications.value.webhook;
  webhook.value = {
    enabled: s.enabled,
    url: s.url ?? "",
    secret: "",
    clearSecret: false,
    headers: Object.entries(s.headers).map(([name, value]) => ({
      name,
      value,
    })),
    dirty: false,
  };
}

watch(
  () => notifications.value.telegram,
  () => {
    if (!telegram.value.dirty) {
      syncTelegram();
    }
  },
  { immediate: true, deep: true },
);

watch(
  () => notifications.value.matrix,
  () => {
    if (!matrix.value.dirty) {
      syncMatrix();
    }
  },
  { immediate: true, deep: true },
);

watch(
  () => notifications.value.webhook,
  () => {
    if (!webhook.value.dirty) {
      syncWebhook();
    }
  },
  { immediate: true, deep: true },
);

const normalizedWebhookHeaders = computed(() => {
  const out: Record<string, string> = {};
  for (const row of webhook.value.headers) {
    const name = row.name.trim();
    if (name || row.value) {
      out[name] = row.value;
    }
  }

  return out;
});

const tgHasChanges = computed(() => {
  const s = notifications.value.telegram;
  const d = telegram.value;

  return (
    d.enabled !== s.enabled ||
    (d.chatId.trim() || null) !== s.chat_id ||
    d.botToken.trim().length > 0 ||
    d.clearToken
  );
});

const mxHasChanges = computed(() => {
  const s = notifications.value.matrix;
  const d = matrix.value;

  return (
    d.enabled !== s.enabled ||
    (d.homeserver.trim().replace(/\/+$/, "") || null) !== s.homeserver ||
    (d.roomId.trim() || null) !== s.room_id ||
    d.accessToken.trim().length > 0 ||
    d.clearToken
  );
});

const whHasChanges = computed(() => {
  const s = notifications.value.webhook;
  const d = webhook.value;

  return (
    d.enabled !== s.enabled ||
    (d.url.trim() || null) !== s.url ||
    d.secret.trim().length > 0 ||
    d.clearSecret ||
    JSON.stringify(normalizedWebhookHeaders.value) !== JSON.stringify(s.headers)
  );
});

function secretPlaceholder(source: SecretSource, emptyPlaceholder: string) {
  if (source === "db") {
    return "Leave blank to keep saved value";
  }
  if (source === "env") {
    return "Leave blank to use environment value";
  }

  return emptyPlaceholder;
}

function channelStatus(enabled: boolean, configured: boolean) {
  if (enabled && configured) {
    return { label: "Active", color: "success" as const };
  }
  if (configured) {
    return { label: "Off", color: "neutral" as const };
  }

  return { label: "Not configured", color: "neutral" as const };
}

function toggleExpanded(channel: NotificationChannelName) {
  expanded.value = expanded.value === channel ? null : channel;
}

async function onQuickToggle(channel: NotificationChannelName, next: boolean) {
  const summary = notifications.value[channel];
  const draft =
    channel === "telegram"
      ? telegram.value
      : channel === "matrix"
        ? matrix.value
        : webhook.value;
  const hasChanges =
    channel === "telegram"
      ? tgHasChanges.value
      : channel === "matrix"
        ? mxHasChanges.value
        : whHasChanges.value;

  if ((next && !summary.configured) || hasChanges) {
    draft.enabled = next;
    draft.dirty = true;
    expanded.value = channel;

    return;
  }

  const label =
    channel === "telegram"
      ? "Telegram"
      : channel === "matrix"
        ? "Matrix"
        : "Webhook";

  await run(
    `toggle:${channel}`,
    `Could not update ${label}`,
    async () => {
      await apiFetch("/api/v1/admin/settings", "PATCH", {
        notifications: { [channel]: { enabled: next } },
      });

      return `${label} ${next ? "enabled" : "disabled"}`;
    },
    true,
  );
}

async function saveTelegram() {
  const d = telegram.value;
  const patch: Record<string, unknown> = {
    enabled: d.enabled,
    chat_id: d.chatId.trim() || null,
  };
  if (d.botToken.trim()) {
    patch.bot_token = d.botToken.trim();
  } else if (d.clearToken) {
    patch.bot_token = null;
  }

  const ok = await run(
    "save:telegram",
    "Could not save Telegram settings",
    async () => {
      await apiFetch("/api/v1/admin/settings", "PATCH", {
        notifications: { telegram: patch },
      });

      return "Telegram settings saved";
    },
    true,
  );
  if (ok) {
    d.botToken = "";
    d.clearToken = false;
    d.dirty = false;
  }
}

async function saveMatrix() {
  const d = matrix.value;
  const patch: Record<string, unknown> = {
    enabled: d.enabled,
    homeserver: d.homeserver.trim() || null,
    room_id: d.roomId.trim() || null,
  };
  if (d.accessToken.trim()) {
    patch.access_token = d.accessToken.trim();
  } else if (d.clearToken) {
    patch.access_token = null;
  }

  const ok = await run(
    "save:matrix",
    "Could not save Matrix settings",
    async () => {
      await apiFetch("/api/v1/admin/settings", "PATCH", {
        notifications: { matrix: patch },
      });

      return "Matrix settings saved";
    },
    true,
  );
  if (ok) {
    d.accessToken = "";
    d.clearToken = false;
    d.dirty = false;
  }
}

async function saveWebhook() {
  const d = webhook.value;
  const patch: Record<string, unknown> = {
    enabled: d.enabled,
    url: d.url.trim() || null,
    headers: normalizedWebhookHeaders.value,
  };
  if (d.secret.trim()) {
    patch.secret = d.secret.trim();
  } else if (d.clearSecret) {
    patch.secret = null;
  }

  const ok = await run(
    "save:webhook",
    "Could not save Webhook settings",
    async () => {
      await apiFetch("/api/v1/admin/settings", "PATCH", {
        notifications: { webhook: patch },
      });

      return "Webhook settings saved";
    },
    true,
  );
  if (ok) {
    d.secret = "";
    d.clearSecret = false;
    d.dirty = false;
  }
}

function addWebhookHeader() {
  if (webhook.value.headers.length >= MAX_HEADERS) {
    return;
  }
  webhook.value.headers.push({ name: "", value: "" });
  webhook.value.dirty = true;
}

function removeWebhookHeader(index: number) {
  webhook.value.headers.splice(index, 1);
  webhook.value.dirty = true;
}

async function testChannel(channel: NotificationChannelName) {
  const label =
    channel === "telegram"
      ? "Telegram"
      : channel === "matrix"
        ? "Matrix"
        : "Webhook";

  await run(`test:${channel}`, `${label} test failed`, async () => {
    const { delivery = {} } = await apiFetch<{
      delivery?: Record<string, string>;
    }>("/api/v1/admin/notifications/test", "POST", { channel });
    if (delivery.status === "no_channels_configured") {
      toast.add({
        title: `${label} is not active`,
        color: "warning",
      });

      return;
    }
    const result = delivery[channel];
    if (result !== "ok") {
      throw new Error(result ?? "Delivery failed");
    }

    return `${label} test sent`;
  });
}
</script>

<template>
  <div class="divide-y divide-default rounded-lg border border-default">
    <!-- Telegram -->
    <div>
      <div class="flex items-center justify-between gap-3 px-3.5 py-2.5">
        <button
          :aria-expanded="expanded === 'telegram'"
          class="flex min-w-0 flex-1 items-center gap-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          type="button"
          @click="toggleExpanded('telegram')"
        >
          <UIcon
            class="size-4 shrink-0 text-muted transition-transform duration-150"
            :class="{ 'rotate-90': expanded === 'telegram' }"
            name="i-lucide-chevron-right"
          />
          <span class="text-sm font-medium">Telegram</span>
          <UBadge
            :color="
              channelStatus(
                notifications.telegram.enabled,
                notifications.telegram.configured,
              ).color
            "
            size="sm"
            variant="subtle"
          >
            {{
              channelStatus(
                notifications.telegram.enabled,
                notifications.telegram.configured,
              ).label
            }}
          </UBadge>
        </button>

        <USwitch
          aria-label="Enable Telegram notifications"
          :disabled="busy === 'toggle:telegram' || busy === 'save:telegram'"
          :model-value="telegram.enabled"
          @update:model-value="onQuickToggle('telegram', Boolean($event))"
        />
      </div>

      <form
        v-if="expanded === 'telegram'"
        class="space-y-3.5 border-t border-default bg-muted/20 px-3.5 py-4"
        @submit.prevent="saveTelegram"
      >
        <UFormField label="Bot token" name="telegram_bot_token">
          <template #hint>
            <SecretSourceHint
              :clearing="telegram.clearToken"
              :source="notifications.telegram.bot_token_source"
              @clear="
                telegram.botToken = '';
                telegram.clearToken = true;
                telegram.dirty = true;
              "
              @undo="
                telegram.clearToken = false;
                telegram.dirty = true;
              "
            />
          </template>
          <UInput
            autocomplete="off"
            class="w-full font-mono"
            :disabled="telegram.clearToken"
            :model-value="telegram.botToken"
            :placeholder="
              secretPlaceholder(
                notifications.telegram.bot_token_source,
                '123456:ABC-DEF...',
              )
            "
            type="password"
            @update:model-value="
              telegram.botToken = String($event);
              telegram.dirty = true;
            "
          />
        </UFormField>

        <UFormField label="Chat ID" name="telegram_chat_id">
          <UInput
            class="w-full font-mono"
            :model-value="telegram.chatId"
            placeholder="-1001234567890"
            @update:model-value="
              telegram.chatId = String($event);
              telegram.dirty = true;
            "
          />
        </UFormField>

        <div class="flex flex-wrap items-center justify-between gap-2 pt-1">
          <div class="flex items-center gap-2">
            <UButton
              color="primary"
              :disabled="!tgHasChanges"
              :loading="busy === 'save:telegram'"
              size="xs"
              type="submit"
            >
              Save changes
            </UButton>
            <UButton
              v-if="tgHasChanges"
              color="neutral"
              size="xs"
              type="button"
              variant="ghost"
              @click="syncTelegram"
            >
              Reset
            </UButton>
          </div>
          <UButton
            v-if="
              notifications.telegram.enabled &&
              notifications.telegram.configured &&
              !tgHasChanges
            "
            color="neutral"
            :loading="busy === 'test:telegram'"
            size="xs"
            type="button"
            variant="soft"
            @click="testChannel('telegram')"
          >
            Test
          </UButton>
        </div>
      </form>
    </div>

    <!-- Matrix -->
    <div>
      <div class="flex items-center justify-between gap-3 px-3.5 py-2.5">
        <button
          :aria-expanded="expanded === 'matrix'"
          class="flex min-w-0 flex-1 items-center gap-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          type="button"
          @click="toggleExpanded('matrix')"
        >
          <UIcon
            class="size-4 shrink-0 text-muted transition-transform duration-150"
            :class="{ 'rotate-90': expanded === 'matrix' }"
            name="i-lucide-chevron-right"
          />
          <span class="text-sm font-medium">Matrix</span>
          <UBadge
            :color="
              channelStatus(
                notifications.matrix.enabled,
                notifications.matrix.configured,
              ).color
            "
            size="sm"
            variant="subtle"
          >
            {{
              channelStatus(
                notifications.matrix.enabled,
                notifications.matrix.configured,
              ).label
            }}
          </UBadge>
        </button>

        <USwitch
          aria-label="Enable Matrix notifications"
          :disabled="busy === 'toggle:matrix' || busy === 'save:matrix'"
          :model-value="matrix.enabled"
          @update:model-value="onQuickToggle('matrix', Boolean($event))"
        />
      </div>

      <form
        v-if="expanded === 'matrix'"
        class="space-y-3.5 border-t border-default bg-muted/20 px-3.5 py-4"
        @submit.prevent="saveMatrix"
      >
        <UFormField label="Homeserver URL" name="matrix_homeserver">
          <UInput
            class="w-full font-mono"
            :model-value="matrix.homeserver"
            placeholder="https://matrix.example.org"
            type="url"
            @update:model-value="
              matrix.homeserver = String($event);
              matrix.dirty = true;
            "
          />
        </UFormField>

        <UFormField label="Room ID" name="matrix_room_id">
          <UInput
            class="w-full font-mono"
            :model-value="matrix.roomId"
            placeholder="!roomid:example.org"
            @update:model-value="
              matrix.roomId = String($event);
              matrix.dirty = true;
            "
          />
        </UFormField>

        <UFormField label="Access token" name="matrix_access_token">
          <template #hint>
            <SecretSourceHint
              :clearing="matrix.clearToken"
              :source="notifications.matrix.access_token_source"
              @clear="
                matrix.accessToken = '';
                matrix.clearToken = true;
                matrix.dirty = true;
              "
              @undo="
                matrix.clearToken = false;
                matrix.dirty = true;
              "
            />
          </template>
          <UInput
            autocomplete="off"
            class="w-full font-mono"
            :disabled="matrix.clearToken"
            :model-value="matrix.accessToken"
            :placeholder="
              secretPlaceholder(
                notifications.matrix.access_token_source,
                'syt_...',
              )
            "
            type="password"
            @update:model-value="
              matrix.accessToken = String($event);
              matrix.dirty = true;
            "
          />
        </UFormField>

        <div class="flex flex-wrap items-center justify-between gap-2 pt-1">
          <div class="flex items-center gap-2">
            <UButton
              color="primary"
              :disabled="!mxHasChanges"
              :loading="busy === 'save:matrix'"
              size="xs"
              type="submit"
            >
              Save changes
            </UButton>
            <UButton
              v-if="mxHasChanges"
              color="neutral"
              size="xs"
              type="button"
              variant="ghost"
              @click="syncMatrix"
            >
              Reset
            </UButton>
          </div>
          <UButton
            v-if="
              notifications.matrix.enabled &&
              notifications.matrix.configured &&
              !mxHasChanges
            "
            color="neutral"
            :loading="busy === 'test:matrix'"
            size="xs"
            type="button"
            variant="soft"
            @click="testChannel('matrix')"
          >
            Test
          </UButton>
        </div>
      </form>
    </div>

    <!-- Webhook -->
    <div>
      <div class="flex items-center justify-between gap-3 px-3.5 py-2.5">
        <button
          :aria-expanded="expanded === 'webhook'"
          class="flex min-w-0 flex-1 items-center gap-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          type="button"
          @click="toggleExpanded('webhook')"
        >
          <UIcon
            class="size-4 shrink-0 text-muted transition-transform duration-150"
            :class="{ 'rotate-90': expanded === 'webhook' }"
            name="i-lucide-chevron-right"
          />
          <span class="text-sm font-medium">Webhook</span>
          <UBadge
            :color="
              channelStatus(
                notifications.webhook.enabled,
                notifications.webhook.configured,
              ).color
            "
            size="sm"
            variant="subtle"
          >
            {{
              channelStatus(
                notifications.webhook.enabled,
                notifications.webhook.configured,
              ).label
            }}
          </UBadge>
        </button>

        <USwitch
          aria-label="Enable Webhook notifications"
          :disabled="busy === 'toggle:webhook' || busy === 'save:webhook'"
          :model-value="webhook.enabled"
          @update:model-value="onQuickToggle('webhook', Boolean($event))"
        />
      </div>

      <form
        v-if="expanded === 'webhook'"
        class="space-y-3.5 border-t border-default bg-muted/20 px-3.5 py-4"
        @submit.prevent="saveWebhook"
      >
        <UFormField label="Endpoint URL" name="webhook_url">
          <UInput
            class="w-full font-mono"
            :model-value="webhook.url"
            placeholder="https://hooks.example.com/uptarn"
            type="url"
            @update:model-value="
              webhook.url = String($event);
              webhook.dirty = true;
            "
          />
        </UFormField>

        <UFormField label="Signing secret" name="webhook_secret">
          <template #hint>
            <SecretSourceHint
              :clearing="webhook.clearSecret"
              optional
              :source="notifications.webhook.secret_source"
              @clear="
                webhook.secret = '';
                webhook.clearSecret = true;
                webhook.dirty = true;
              "
              @undo="
                webhook.clearSecret = false;
                webhook.dirty = true;
              "
            />
          </template>
          <UInput
            autocomplete="off"
            class="w-full font-mono"
            :disabled="webhook.clearSecret"
            :model-value="webhook.secret"
            :placeholder="
              secretPlaceholder(
                notifications.webhook.secret_source,
                'HMAC-SHA256 signing secret',
              )
            "
            type="password"
            @update:model-value="
              webhook.secret = String($event);
              webhook.dirty = true;
            "
          />
        </UFormField>

        <div class="space-y-2">
          <div class="flex items-center justify-between gap-2">
            <span class="text-xs font-medium text-default">Custom headers</span>
            <UButton
              v-if="webhook.headers.length < MAX_HEADERS"
              color="neutral"
              icon="i-lucide-plus"
              size="xs"
              type="button"
              variant="soft"
              @click="addWebhookHeader"
            >
              Add header
            </UButton>
          </div>

          <div v-if="webhook.headers.length > 0" class="space-y-2">
            <div
              v-for="(row, idx) in webhook.headers"
              :key="idx"
              class="grid grid-cols-[minmax(6rem,8.5rem)_minmax(0,1fr)_auto] items-center gap-2 sm:grid-cols-[10rem_minmax(0,1fr)_auto]"
            >
              <UInput
                aria-label="Header name"
                class="w-full font-mono"
                :maxlength="64"
                :model-value="row.name"
                placeholder="X-Custom-Header"
                required
                @update:model-value="
                  row.name = String($event);
                  webhook.dirty = true;
                "
              />
              <UInput
                aria-label="Header value"
                class="w-full font-mono"
                :maxlength="512"
                :model-value="row.value"
                placeholder="Value"
                @update:model-value="
                  row.value = String($event);
                  webhook.dirty = true;
                "
              />
              <UButton
                aria-label="Remove header"
                color="neutral"
                icon="i-lucide-x"
                size="md"
                type="button"
                variant="ghost"
                @click="removeWebhookHeader(idx)"
              />
            </div>
          </div>
          <p v-else class="text-xs text-dimmed">No custom headers.</p>
        </div>

        <div class="flex flex-wrap items-center justify-between gap-2 pt-1">
          <div class="flex items-center gap-2">
            <UButton
              color="primary"
              :disabled="!whHasChanges"
              :loading="busy === 'save:webhook'"
              size="xs"
              type="submit"
            >
              Save changes
            </UButton>
            <UButton
              v-if="whHasChanges"
              color="neutral"
              size="xs"
              type="button"
              variant="ghost"
              @click="syncWebhook"
            >
              Reset
            </UButton>
          </div>
          <UButton
            v-if="
              notifications.webhook.enabled &&
              notifications.webhook.configured &&
              !whHasChanges
            "
            color="neutral"
            :loading="busy === 'test:webhook'"
            size="xs"
            type="button"
            variant="soft"
            @click="testChannel('webhook')"
          >
            Test
          </UButton>
        </div>
      </form>
    </div>
  </div>
</template>
