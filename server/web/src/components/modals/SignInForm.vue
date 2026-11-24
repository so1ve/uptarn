<script setup lang="ts">
import { computed, ref } from "vue";

import type { AuthMethodsSummary } from "../../lib/index.ts";
import { apiFetch, signInWithPasskey, useAction } from "../../lib/index.ts";

const emit = defineEmits<{
  authenticated: [];
}>();

const props = defineProps<{
  auth: AuthMethodsSummary;
}>();

const { busy, run } = useAction();
const password = ref("");

const unconfigured = computed(
  () =>
    !props.auth.password_enabled &&
    props.auth.passkey_count === 0 &&
    !props.auth.cf_access_enabled,
);

async function onPasswordSubmit() {
  if (!password.value) {
    return;
  }
  const ok = await run("password", "Sign-in failed", async () => {
    await apiFetch("/api/v1/auth/login", "POST", { password: password.value });
  });
  if (ok) {
    emit("authenticated");
  }
}

async function onPasskeySignIn() {
  const ok = await run("passkey", "Passkey sign-in failed", () =>
    signInWithPasskey(),
  );
  if (ok) {
    emit("authenticated");
  }
}
</script>

<template>
  <UAlert
    v-if="unconfigured"
    color="error"
    description="Set ADMIN_PASSWORD or ADMIN_TOKEN on the server."
    icon="i-lucide-circle-alert"
    title="No sign-in method configured"
    variant="subtle"
  />

  <div v-else class="space-y-4">
    <UButton
      v-if="auth.passkey_count > 0"
      block
      color="primary"
      icon="i-lucide-fingerprint"
      :loading="busy === 'passkey'"
      @click="onPasskeySignIn"
    >
      Sign in with passkey
    </UButton>

    <USeparator
      v-if="auth.passkey_count > 0 && auth.password_enabled"
      label="or"
    />

    <form
      v-if="auth.password_enabled"
      class="space-y-4"
      @submit.prevent="onPasswordSubmit"
    >
      <UFormField label="Password" name="password">
        <UInput
          v-model="password"
          autocomplete="current-password"
          autofocus
          class="w-full"
          required
          type="password"
        />
      </UFormField>
      <UButton
        block
        :color="auth.passkey_count > 0 ? 'neutral' : 'primary'"
        :loading="busy === 'password'"
        type="submit"
        :variant="auth.passkey_count > 0 ? 'soft' : 'solid'"
      >
        Sign in
      </UButton>
    </form>
  </div>
</template>
