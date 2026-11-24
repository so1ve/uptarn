<script setup lang="ts">
import { computed } from "vue";

import {
  apiFetch,
  formatRemaining,
  useAction,
  useSnapshot,
} from "../../lib/index.ts";
import PasskeysSection from "./PasskeysSection.vue";

const open = defineModel<boolean>("open", { default: false });

const toast = useToast();
const snap = useSnapshot();
const { busy, run, copy } = useAction();

const settings = computed(() => snap.value.settings);
const globalMuted = computed(
  () => settings.value.global_muted_until > snap.value.now,
);

const GLOBAL_MUTES = [
  { label: "1h", secs: 3600 },
  { label: "6h", secs: 21_600 },
] as const;

const patchSettings = (
  key: string,
  failTitle: string,
  body: Record<string, unknown>,
  okMessage: string,
) =>
  run(
    key,
    failTitle,
    async () => {
      await apiFetch("/api/v1/admin/settings", "PATCH", body);

      return okMessage;
    },
    true,
  );

const onSendTestAlert = () =>
  run("test", "Test alert failed", async () => {
    const { delivery = {} } = await apiFetch<{
      delivery?: Record<string, string>;
    }>("/api/v1/admin/notifications/test", "POST");
    if (delivery.status === "no_channels_configured") {
      toast.add({ title: "No alert channels configured", color: "warning" });

      return;
    }
    const failed = Object.entries(delivery).filter(([, v]) => v !== "ok");
    if (failed.length > 0) {
      throw new Error(failed.map(([k, v]) => `${k}: ${v}`).join("; "));
    }

    return "Test alert sent";
  });
</script>

<template>
  <UModal v-model:open="open" title="Settings" :ui="{ content: 'max-w-lg' }">
    <template #body>
      <div class="space-y-6">
        <section class="space-y-3">
          <h3 class="text-xs font-semibold text-muted">Node registration</h3>
          <USwitch
            :disabled="busy === 'enroll'"
            label="Auto-register with enrollment token"
            :model-value="settings.auto_register"
            @update:model-value="
              patchSettings(
                'enroll',
                'Failed to update registration',
                { auto_register: $event },
                $event
                  ? 'Node registration opened'
                  : 'Node registration closed',
              )
            "
          />
          <UFormField label="Enrollment token">
            <div class="flex items-center gap-2">
              <UInput
                class="flex-1 font-mono"
                :model-value="settings.enrollment_token ?? ''"
                readonly
              />
              <UButton
                v-if="settings.enrollment_token"
                aria-label="Copy enrollment token"
                color="neutral"
                icon="i-lucide-copy"
                size="sm"
                variant="soft"
                @click="copy(settings.enrollment_token, 'Enrollment token')"
              />
              <UButton
                color="neutral"
                :loading="busy === 'rotate'"
                size="sm"
                variant="soft"
                @click="
                  patchSettings(
                    'rotate',
                    'Rotation failed',
                    { rotate_enrollment_token: true },
                    'Enrollment token rotated',
                  )
                "
              >
                Rotate
              </UButton>
            </div>
          </UFormField>
        </section>

        <USeparator />

        <section class="space-y-3">
          <h3 class="text-xs font-semibold text-muted">Alerts</h3>
          <div
            class="flex flex-wrap items-center justify-between gap-2 text-sm"
          >
            <div class="flex items-center gap-3">
              <span class="text-muted">Channels</span>
              <UBadge
                v-for="[name, on] in [
                  ['Telegram', settings.channels.telegram],
                  ['Matrix', settings.channels.matrix],
                ] as const"
                :key="name"
                :color="on ? 'success' : 'neutral'"
                size="sm"
                variant="subtle"
              >
                {{ name }} {{ on ? "on" : "off" }}
              </UBadge>
            </div>
            <UButton
              color="neutral"
              :loading="busy === 'test'"
              size="xs"
              variant="soft"
              @click="onSendTestAlert"
            >
              Send test
            </UButton>
          </div>

          <div
            class="flex flex-wrap items-center justify-between gap-2 text-sm"
          >
            <div class="flex items-center gap-3">
              <span class="text-muted">Mute all</span>
              <span
                :class="
                  globalMuted
                    ? 'text-amber-600 dark:text-amber-400'
                    : 'text-dimmed'
                "
              >
                {{
                  globalMuted
                    ? `${formatRemaining(settings.global_muted_until, snap.now)} remaining`
                    : "Off"
                }}
              </span>
            </div>
            <div class="flex items-center gap-1.5">
              <UButton
                v-for="m in GLOBAL_MUTES"
                :key="m.secs"
                color="neutral"
                :loading="busy === `mute:${m.secs}`"
                size="xs"
                variant="soft"
                @click="
                  patchSettings(
                    `mute:${m.secs}`,
                    'Failed to update mute',
                    { global_mute_secs: m.secs },
                    'All alerts muted',
                  )
                "
              >
                {{ m.label }}
              </UButton>
              <UButton
                v-if="globalMuted"
                color="primary"
                :loading="busy === 'mute:0'"
                size="xs"
                variant="soft"
                @click="
                  patchSettings(
                    'mute:0',
                    'Failed to update mute',
                    { global_mute_secs: 0 },
                    'All alerts resumed',
                  )
                "
              >
                Resume
              </UButton>
            </div>
          </div>
        </section>

        <USeparator />

        <PasskeysSection />
      </div>
    </template>
  </UModal>
</template>
