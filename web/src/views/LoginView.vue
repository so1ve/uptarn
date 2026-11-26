<script setup lang="ts">
import { useRouter } from "vue-router";

import SignInForm from "../components/modals/SignInForm.vue";
import BrandMark from "../components/ui/BrandMark.vue";
import type { PublicStatusSnapshot } from "../lib/index.ts";
import { hostOf, usePageTitle, useUptarnStore } from "../lib/index.ts";

defineProps<{
  status: PublicStatusSnapshot;
}>();

const router = useRouter();
const { isDark, toggleTheme, loadState } = useUptarnStore();
usePageTitle("Sign in");

async function onAuthenticated() {
  await loadState();
  await router.push("/admin/nodes");
}
</script>

<template>
  <div class="grid min-h-svh place-items-center px-4 py-10">
    <div
      class="w-full max-w-sm rounded-xl border border-default bg-surface p-6 shadow-sm"
    >
      <div class="mb-6 flex items-center justify-between gap-3">
        <BrandMark
          :host="hostOf(status.public_base_url)"
          :title="status.site_title"
        />
        <UButton
          aria-label="Toggle theme"
          class="shrink-0"
          color="neutral"
          :icon="isDark ? 'i-lucide-sun' : 'i-lucide-moon'"
          size="xs"
          variant="ghost"
          @click="toggleTheme"
        />
      </div>

      <h1 class="mb-5 text-lg font-semibold tracking-tight">Sign in</h1>

      <SignInForm :auth="status.auth" @authenticated="onAuthenticated" />
    </div>
  </div>
</template>
