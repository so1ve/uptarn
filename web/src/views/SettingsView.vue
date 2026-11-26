<script setup lang="ts">
import { computed } from "vue";

import AlertRetentionSettingsForm from "../components/settings/AlertRetentionSettingsForm.vue";
import NotificationChannelsForm from "../components/settings/NotificationChannelsForm.vue";
import PasskeysSection from "../components/settings/PasskeysSection.vue";
import StatusPageSettingsForm from "../components/settings/StatusPageSettingsForm.vue";
import CopyField from "../components/ui/CopyField.vue";
import MuteButton from "../components/ui/MuteButton.vue";
import PageHeader from "../components/ui/PageHeader.vue";
import {
  apiFetch,
  useAction,
  usePageTitle,
  useSnapshot,
} from "../lib/index.ts";

usePageTitle("Settings");

const toast = useToast();
const snap = useSnapshot();
const { busy, run } = useAction();

const settings = computed(() => snap.value.settings);
const hasActiveChannel = computed(
  () =>
    settings.value.channels.telegram ||
    settings.value.channels.matrix ||
    settings.value.channels.webhook,
);

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
      <section
        class="grid grid-cols-1 gap-4 py-6 md:grid-cols-[14rem_1fr] md:gap-6"
      >
        <h2 class="text-sm font-semibold md:pt-0.5">Status page</h2>
        <div class="max-w-xl">
          <StatusPageSettingsForm />
        </div>
      </section>

      <section
        class="grid grid-cols-1 gap-4 py-6 md:grid-cols-[14rem_1fr] md:gap-6"
      >
        <h2 class="text-sm font-semibold md:pt-0.5">Alerts &amp; retention</h2>
        <div class="max-w-xl">
          <AlertRetentionSettingsForm />
        </div>
      </section>

      <section
        class="grid grid-cols-1 gap-4 py-6 md:grid-cols-[14rem_1fr] md:gap-6"
      >
        <h2 class="text-sm font-semibold md:pt-0.5">Notifications</h2>
        <div class="max-w-xl space-y-4">
          <NotificationChannelsForm />

          <div class="flex flex-wrap items-center justify-between gap-2">
            <MuteButton
              :muted-until="settings.global_muted_until"
              :now="snap.now"
              target-type="global"
              variant="soft"
            />
            <UButton
              color="neutral"
              :disabled="!hasActiveChannel"
              :loading="busy === 'test'"
              size="xs"
              variant="soft"
              @click="onSendTestNotification"
            >
              Test all
            </UButton>
          </div>
        </div>
      </section>

      <section
        class="grid grid-cols-1 gap-4 py-6 md:grid-cols-[14rem_1fr] md:gap-6"
      >
        <h2 class="text-sm font-semibold md:pt-0.5">Node registration</h2>
        <div class="max-w-xl space-y-4">
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
              size="md"
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

      <section
        class="grid grid-cols-1 gap-4 py-6 md:grid-cols-[14rem_1fr] md:gap-6"
      >
        <h2 class="text-sm font-semibold md:pt-0.5">Sign-in &amp; passkeys</h2>
        <div class="max-w-xl">
          <PasskeysSection />
        </div>
      </section>
    </div>
  </div>
</template>
