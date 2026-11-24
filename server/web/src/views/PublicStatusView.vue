<script setup lang="ts">
import { computed, ref } from "vue";

import SignInForm from "../components/modals/SignInForm.vue";
import MonitorRow from "../components/monitors/MonitorRow.vue";
import SparkMetric from "../components/ui/SparkMetric.vue";
import StatusDot from "../components/ui/StatusDot.vue";
import UsageBar from "../components/ui/UsageBar.vue";
import AppLayout from "../layouts/AppLayout.vue";
import type { PublicStatusSnapshot } from "../lib/index.ts";
import {
  formatDuration,
  hostOf,
  usageTextClass,
  useLiveRefresh,
  useUptarnStore,
} from "../lib/index.ts";

const props = defineProps<{
  status: PublicStatusSnapshot;
}>();

const { loadState } = useUptarnStore();
const signInOpen = ref(false);

document.title = "Status - Uptarn";
useLiveRefresh("public", 10_000, 3000);

const BANNER_STYLES = {
  fail: { bg: "bg-red-500/10", text: "text-red-600 dark:text-red-400" },
  warn: { bg: "bg-amber-500/10", text: "text-amber-600 dark:text-amber-400" },
  ok: {
    bg: "bg-emerald-500/10",
    text: "text-emerald-700 dark:text-emerald-400",
  },
} as const;

const banner = computed(() => {
  const failing =
    props.status.monitors.filter((m) => m.enabled && m.last_status === "fail")
      .length +
    props.status.nodes.filter(
      (n) => n.overall_status === "fail" || n.overall_status === "offline",
    ).length;
  if (failing > 0) {
    return {
      tone: "fail" as const,
      text:
        failing === 1
          ? "1 service experiencing issues"
          : `${failing} services experiencing issues`,
    };
  }
  if (props.status.nodes.some((n) => n.overall_status === "warn")) {
    return { tone: "warn" as const, text: "Partial system degradation" };
  }

  return { tone: "ok" as const, text: "All systems operational" };
});

async function onSignedIn() {
  signInOpen.value = false;
  await loadState();
}
</script>

<template>
  <AppLayout :host="hostOf(status.public_base_url)" :version="status.version">
    <template #actions>
      <UButton
        color="neutral"
        size="sm"
        variant="soft"
        @click="signInOpen = true"
      >
        Sign in
      </UButton>
    </template>

    <div class="space-y-8">
      <div
        class="flex items-center gap-2.5 rounded-xl px-4 py-3 text-sm"
        :class="BANNER_STYLES[banner.tone].bg"
      >
        <StatusDot size-class="size-2.5" :status="banner.tone" />
        <span class="font-semibold" :class="BANNER_STYLES[banner.tone].text">
          {{ banner.text }}
        </span>
      </div>

      <section v-if="status.monitors.length > 0" class="space-y-3">
        <h2 class="text-base font-semibold tracking-tight">Services</h2>
        <div class="divide-y divide-default border-y border-default">
          <MonitorRow
            v-for="mon in status.monitors"
            :key="mon.key"
            :monitor="mon"
            :now="status.now"
          />
        </div>
      </section>

      <section v-if="status.nodes.length > 0" class="space-y-3">
        <h2 class="text-base font-semibold tracking-tight">Nodes</h2>
        <div class="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          <div
            v-for="node in status.nodes"
            :key="node.key"
            class="flex flex-col justify-between gap-4 rounded-xl border border-default bg-surface px-5 py-4"
          >
            <div class="flex items-center justify-between gap-3">
              <div class="flex min-w-0 items-center gap-2">
                <StatusDot :status="node.overall_status" />
                <span class="truncate text-[14.5px] font-semibold">
                  {{ node.label }}
                </span>
              </div>
              <span
                v-if="
                  node.overall_status !== 'offline' &&
                  node.overall_status !== 'pending' &&
                  node.uptime_secs !== null
                "
                class="shrink-0 font-mono text-xs text-muted tabular-nums"
              >
                Up {{ formatDuration(node.uptime_secs) }}
              </span>
              <span
                v-else-if="node.overall_status === 'offline'"
                class="shrink-0 font-mono text-xs text-red-500 dark:text-red-400"
              >
                Offline
              </span>
            </div>

            <div
              class="space-y-3"
              :class="node.overall_status === 'offline' ? 'opacity-50' : ''"
            >
              <div
                v-if="node.cpu_pct !== null || node.mem_pct !== null"
                class="grid gap-5"
                :class="
                  node.cpu_pct !== null && node.mem_pct !== null
                    ? 'grid-cols-2'
                    : 'grid-cols-1'
                "
              >
                <SparkMetric
                  v-if="node.cpu_pct !== null"
                  :history="node.cpu_history"
                  kind="cpu"
                  :pct="node.cpu_pct"
                />
                <SparkMetric
                  v-if="node.mem_pct !== null"
                  :history="node.mem_history"
                  kind="memory"
                  :pct="node.mem_pct"
                />
              </div>

              <div v-if="node.storage_pct !== null" class="space-y-1.5">
                <div
                  class="flex items-baseline justify-between gap-2 font-mono text-xs tabular-nums"
                >
                  <span class="font-sans text-muted">Storage</span>
                  <span :class="usageTextClass(node.storage_pct, 85, 92)">
                    {{ Math.round(node.storage_pct) }}%
                  </span>
                </div>
                <UsageBar :pct="node.storage_pct" />
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>

    <UModal
      v-model:open="signInOpen"
      title="Sign in"
      :ui="{ content: 'max-w-sm' }"
    >
      <template #body>
        <SignInForm :auth="status.auth" @authenticated="onSignedIn" />
      </template>
    </UModal>
  </AppLayout>
</template>
