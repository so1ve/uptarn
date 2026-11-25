<script setup lang="ts">
import { computed } from "vue";
import { useRoute, useRouter } from "vue-router";

import StatusDot from "../components/ui/StatusDot.vue";
import AppLayout from "../layouts/AppLayout.vue";
import { hostOf, usePageTitle, useUptarnStore } from "../lib/index.ts";

usePageTitle("Not found");

const route = useRoute();
const router = useRouter();
const { snapshot, publicStatus } = useUptarnStore();

const isAdmin = computed(() => snapshot.value !== null);
const homeTo = computed(() => (isAdmin.value ? "/admin/nodes" : "/"));
const version = computed(
  () => snapshot.value?.version ?? publicStatus.value?.version ?? "",
);
const links = computed(
  () => snapshot.value?.settings.site_links ?? publicStatus.value?.site_links,
);
const siteTitle = computed(() =>
  isAdmin.value ? undefined : publicStatus.value?.site_title,
);
const host = computed(() =>
  isAdmin.value || !publicStatus.value
    ? undefined
    : hostOf(publicStatus.value.public_base_url),
);

const SIGNAL_BARS = [
  { h: "h-3", state: "ok" },
  { h: "h-4", state: "ok" },
  { h: "h-3.5", state: "ok" },
  { h: "h-5", state: "ok" },
  { h: "h-4", state: "ok" },
  { h: "h-3", state: "ok" },
  { h: "h-4.5", state: "ok" },
  { h: "h-3.5", state: "ok" },
  { h: "h-5", state: "ok" },
  { h: "h-4", state: "ok" },
  { h: "h-2", state: "miss" },
  { h: "h-5.5", state: "fail" },
  { h: "h-2", state: "miss" },
  { h: "h-3.5", state: "ok" },
  { h: "h-4.5", state: "ok" },
  { h: "h-3", state: "ok" },
  { h: "h-5", state: "ok" },
  { h: "h-4", state: "ok" },
  { h: "h-3.5", state: "ok" },
  { h: "h-4", state: "ok" },
  { h: "h-3", state: "ok" },
] as const;

function goBack() {
  if (window.history.length > 1) {
    router.back();
  } else {
    void router.push(homeTo.value);
  }
}
</script>

<template>
  <AppLayout :home-to :host :links :title="siteTitle" :version>
    <template #actions>
      <RouterLink
        class="ml-1 inline-flex h-8 items-center gap-1.5 rounded-md bg-elevated px-3 text-[13px] font-medium text-highlighted transition-colors hover:bg-accented focus-visible:outline-2 focus-visible:outline-primary"
        :to="homeTo"
      >
        <UIcon class="size-3.5" name="i-lucide-arrow-left" />
        <span>{{ isAdmin ? "Dashboard" : "Status" }}</span>
      </RouterLink>
    </template>

    <section
      aria-labelledby="not-found-title"
      class="flex min-h-[64vh] flex-col items-center justify-center px-2 py-12 text-center"
    >
      <div class="w-full max-w-md space-y-6">
        <div class="flex flex-col items-center gap-4">
          <div
            aria-hidden="true"
            class="inline-flex h-7 items-center gap-1 rounded-full border border-default bg-surface px-3"
          >
            <span
              v-for="(bar, idx) in SIGNAL_BARS"
              :key="idx"
              class="w-[3px] rounded-full"
              :class="[
                bar.h,
                bar.state === 'fail'
                  ? 'bg-red-500 dark:bg-red-400'
                  : bar.state === 'miss'
                    ? 'bg-zinc-300/60 dark:bg-zinc-700/60'
                    : 'bg-emerald-500/45 dark:bg-emerald-400/35',
              ]"
            />
          </div>

          <div class="space-y-2">
            <div
              class="inline-flex items-center gap-2 font-mono text-xs text-muted"
            >
              <StatusDot status="fail" />
              <span>HTTP 404</span>
            </div>
            <h1
              id="not-found-title"
              class="text-2xl font-semibold tracking-tight text-highlighted sm:text-3xl"
            >
              Page not found
            </h1>
            <p class="text-sm text-muted">
              The page you requested does not exist or may have been moved.
            </p>
          </div>
        </div>

        <div class="flex justify-center">
          <div
            class="inline-flex max-w-full items-center gap-2 rounded-lg border border-default bg-surface px-3 py-1.5 font-mono text-xs"
          >
            <span class="shrink-0 text-dimmed">GET</span>
            <span class="truncate text-default">{{ route.fullPath }}</span>
          </div>
        </div>

        <div class="flex flex-wrap items-center justify-center gap-2.5 pt-1">
          <UButton color="primary" :to="homeTo">
            {{ isAdmin ? "Back to dashboard" : "Back to status page" }}
          </UButton>
          <UButton
            color="neutral"
            icon="i-lucide-arrow-left"
            variant="soft"
            @click="goBack"
          >
            Go back
          </UButton>
        </div>
      </div>
    </section>
  </AppLayout>
</template>
