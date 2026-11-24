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

const onToggleAutoRegister = (next: boolean) =>
  run(
    "enroll",
    "Failed to update registration",
    async () => {
      const res = await apiFetch<{ auto_register: boolean }>(
        "/api/v1/admin/settings",
        "PATCH",
        { auto_register: next },
      );

      return res.auto_register
        ? "Node registration opened"
        : "Node registration closed";
    },
    true,
  );

const onRotateEnrollment = () =>
  run(
    "rotate",
    "Rotation failed",
    async () => {
      await apiFetch("/api/v1/admin/settings", "PATCH", {
        rotate_enrollment_token: true,
      });

      return "Enrollment token rotated";
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

const onGlobalMute = (secs: number) =>
  run(
    `mute:${secs}`,
    "Failed to update mute",
    async () => {
      await apiFetch("/api/v1/admin/settings", "PATCH", {
        global_mute_secs: secs,
      });

      return secs > 0 ? "All alerts muted" : "All alerts resumed";
    },
    true,
  );
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
            @update:model-value="onToggleAutoRegister"
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
                @click="onRotateEnrollment"
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
                :color="settings.channels.telegram ? 'success' : 'neutral'"
                size="sm"
                variant="subtle"
              >
                Telegram {{ settings.channels.telegram ? "on" : "off" }}
              </UBadge>
              <UBadge
                :color="settings.channels.matrix ? 'success' : 'neutral'"
                size="sm"
                variant="subtle"
              >
                Matrix {{ settings.channels.matrix ? "on" : "off" }}
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
                color="neutral"
                :loading="busy === 'mute:3600'"
                size="xs"
                variant="soft"
                @click="onGlobalMute(3600)"
              >
                1h
              </UButton>
              <UButton
                color="neutral"
                :loading="busy === 'mute:21600'"
                size="xs"
                variant="soft"
                @click="onGlobalMute(21600)"
              >
                6h
              </UButton>
              <UButton
                v-if="globalMuted"
                color="primary"
                :loading="busy === 'mute:0'"
                size="xs"
                variant="soft"
                @click="onGlobalMute(0)"
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
