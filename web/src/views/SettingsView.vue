<script setup lang="ts">
import { computed } from "vue";

import PasskeysSection from "../components/settings/PasskeysSection.vue";
import StatusPageSettingsForm from "../components/settings/StatusPageSettingsForm.vue";
import CopyField from "../components/ui/CopyField.vue";
import PageHeader from "../components/ui/PageHeader.vue";
import {
  apiFetch,
  formatRemaining,
  useAction,
  useSnapshot,
} from "../lib/index.ts";

const toast = useToast();
const snap = useSnapshot();
const { busy, run } = useAction();

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

const onSendTestNotification = () =>
  run("test", "Test notification failed", async () => {
    const { delivery = {} } = await apiFetch<{
      delivery?: Record<string, string>;
    }>("/api/v1/admin/notifications/test", "POST");
    if (delivery.status === "no_channels_configured") {
      toast.add({
        title: "No notification channels configured",
        color: "warning",
      });

      return;
    }
    const failed = Object.entries(delivery).filter(([, v]) => v !== "ok");
    if (failed.length > 0) {
      throw new Error(failed.map(([k, v]) => `${k}: ${v}`).join("; "));
    }

    return "Test notification sent";
  });
</script>

<template>
  <div class="space-y-6">
    <PageHeader title="Settings" />

    <div class="divide-y divide-default border-y border-default">
      <section class="grid grid-cols-1 gap-4 py-6 md:grid-cols-[14rem_1fr]">
        <h2 class="text-sm font-semibold">Status page</h2>
        <StatusPageSettingsForm />
      </section>

      <section class="grid grid-cols-1 gap-4 py-6 md:grid-cols-[14rem_1fr]">
        <h2 class="text-sm font-semibold">Node registration</h2>
        <div class="max-w-lg space-y-4">
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
          <CopyField
            label="Enrollment token"
            :value="settings.enrollment_token ?? ''"
          >
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
          </CopyField>
        </div>
      </section>

      <section class="grid grid-cols-1 gap-4 py-6 md:grid-cols-[14rem_1fr]">
        <h2 class="text-sm font-semibold">Notifications</h2>
        <div class="max-w-lg space-y-4">
          <div
            class="flex flex-wrap items-center justify-between gap-2 text-sm"
          >
            <div class="flex items-center gap-2.5">
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
              @click="onSendTestNotification"
            >
              Send test
            </UButton>
          </div>

          <div
            class="flex flex-wrap items-center justify-between gap-2 text-sm"
          >
            <div class="flex items-center gap-2.5">
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
                    'All notifications muted',
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
                    'All notifications resumed',
                  )
                "
              >
                Resume
              </UButton>
            </div>
          </div>
        </div>
      </section>

      <section class="grid grid-cols-1 gap-4 py-6 md:grid-cols-[14rem_1fr]">
        <h2 class="text-sm font-semibold">Sign-in &amp; passkeys</h2>
        <div class="max-w-lg">
          <PasskeysSection />
        </div>
      </section>
    </div>
  </div>
</template>
