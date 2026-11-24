<script setup lang="ts">
import ConfirmPopover from "../components/ui/ConfirmPopover.vue";
import EmptyState from "../components/ui/EmptyState.vue";
import PageHeader from "../components/ui/PageHeader.vue";
import StatusDot from "../components/ui/StatusDot.vue";
import type { JobSummary } from "../lib/index.ts";
import {
  apiFetch,
  formatAge,
  formatDuration,
  formatMs,
  formatRemaining,
  useAction,
  useSnapshot,
} from "../lib/index.ts";

const snap = useSnapshot();
const { busy, run, mute } = useAction();

const onToggleMute = (job: JobSummary) =>
  mute(
    `mute:${job.key}`,
    "job",
    job.key,
    job.label,
    job.muted_until > snap.value.now ? 0 : 3600,
  );

const onRemoveJob = (key: string) =>
  run(
    key,
    "Remove failed",
    async () => {
      await apiFetch(`/api/v1/admin/jobs/${encodeURIComponent(key)}`, "DELETE");

      return `Removed job ${key}`;
    },
    true,
  );
</script>

<template>
  <div class="space-y-6">
    <PageHeader title="Jobs" />

    <EmptyState v-if="snap.jobs.length === 0">
      No jobs yet. Report runs with
      <code class="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
        uptarn-agent run
      </code>
      .
    </EmptyState>

    <div v-else class="divide-y divide-default border-y border-default">
      <div v-for="job in snap.jobs" :key="job.key" class="space-y-2 py-4">
        <div class="flex flex-wrap items-center justify-between gap-3">
          <div class="flex min-w-0 flex-wrap items-center gap-2">
            <StatusDot :status="job.overall_status" />
            <span class="text-sm font-semibold">{{ job.label }}</span>
            <span
              v-if="job.label.toLowerCase() !== job.key.toLowerCase()"
              class="font-mono text-xs text-dimmed"
            >
              {{ job.key }}
            </span>
            <RouterLink
              v-if="job.node_id"
              :to="`/nodes/${encodeURIComponent(job.node_id)}`"
            >
              <UBadge
                class="font-mono hover:opacity-80"
                color="neutral"
                size="xs"
                variant="subtle"
              >
                {{ job.node_id }}
              </UBadge>
            </RouterLink>
            <UBadge
              v-if="job.muted_until > snap.now"
              color="warning"
              size="xs"
              variant="subtle"
            >
              Muted {{ formatRemaining(job.muted_until, snap.now) }}
            </UBadge>
          </div>

          <div
            class="flex shrink-0 items-center gap-2 font-mono text-xs tabular-nums"
          >
            <span
              class="mr-1"
              :class="
                job.overall_status === 'ok'
                  ? 'text-muted'
                  : 'text-red-500 dark:text-red-400'
              "
            >
              {{
                job.overall_status === "overdue"
                  ? "Overdue"
                  : formatAge(job.last_run_at, snap.now)
              }}
            </span>

            <UButton
              class="font-sans"
              color="neutral"
              :loading="busy === `mute:${job.key}`"
              size="xs"
              variant="ghost"
              @click="onToggleMute(job)"
            >
              {{ job.muted_until > snap.now ? "Unmute" : "Mute 1h" }}
            </UButton>

            <ConfirmPopover
              label="Remove"
              :loading="busy === job.key"
              @confirm="onRemoveJob(job.key)"
            >
              Remove
              <strong>{{ job.label }}</strong>
              ?
            </ConfirmPopover>
          </div>
        </div>

        <div
          class="flex flex-wrap items-baseline justify-between gap-2 pl-4 text-xs"
        >
          <span
            :class="
              job.last_status === 'fail'
                ? 'text-red-500 dark:text-red-400'
                : 'text-muted'
            "
          >
            {{
              job.overall_status === "overdue"
                ? `Last finished ${formatAge(job.last_run_at, snap.now)}${job.last_summary ? ` (${job.last_summary})` : ""}`
                : (job.last_summary ?? job.last_status)
            }}
          </span>
          <span class="shrink-0 font-mono text-[11px] text-dimmed tabular-nums">
            {{
              `Every ${formatDuration(job.interval_secs)}${job.last_duration_ms === null ? "" : `, ${formatMs(job.last_duration_ms)}`}`
            }}
          </span>
        </div>

        <pre
          v-if="job.last_detail"
          class="ml-4 max-h-56 overflow-auto rounded-lg bg-muted p-3 font-mono text-xs leading-relaxed"
          >{{ job.last_detail }}</pre>
      </div>
    </div>
  </div>
</template>
