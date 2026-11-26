<script setup lang="ts">
import { createReusableTemplate } from "@vueuse/core";
import { ref } from "vue";

import JobModal from "../components/modals/JobModal.vue";
import JobPingModal from "../components/modals/JobPingModal.vue";
import ConfirmPopover from "../components/ui/ConfirmPopover.vue";
import EmptyState from "../components/ui/EmptyState.vue";
import MuteButton from "../components/ui/MuteButton.vue";
import MutedBadge from "../components/ui/MutedBadge.vue";
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
  usePageTitle,
  useSnapshot,
} from "../lib/index.ts";

usePageTitle("Jobs");

const snap = useSnapshot();
const { busy, run } = useAction();
const [DefineJobActions, JobActions] = createReusableTemplate<{
  job: JobSummary;
}>();

const jobModalOpen = ref(false);
const editingJob = ref<JobSummary | null>(null);
const pingModalOpen = ref(false);
const issuedPing = ref<{ key: string; label: string; pingUrl: string } | null>(
  null,
);

function openJobModal(job: JobSummary | null) {
  editingJob.value = job;
  jobModalOpen.value = true;
}

function onIssuedPing(payload: {
  key: string;
  label: string;
  pingUrl: string;
}) {
  issuedPing.value = payload;
  pingModalOpen.value = true;
}

function jobScheduleParts(job: JobSummary): string[] {
  const parts: string[] = [];
  if (job.schedule) {
    parts.push(job.schedule);
  } else if (job.interval_secs !== null) {
    parts.push(`Every ${formatDuration(job.interval_secs)}`);
  }
  if (job.last_duration_ms !== null) {
    parts.push(formatMs(job.last_duration_ms));
  }
  if (
    job.overall_status !== "overdue" &&
    job.overall_status !== "fail" &&
    job.next_due_at !== null &&
    job.next_due_at > snap.value.now
  ) {
    parts.push(`next in ${formatRemaining(job.next_due_at, snap.value.now)}`);
  }

  return parts;
}

function statusTiming(job: JobSummary): { text: string; cls: string } {
  if (job.overall_status === "overdue") {
    return { text: "Overdue", cls: "text-red-500 dark:text-red-400" };
  }
  if (job.overall_status === "fail") {
    return {
      text:
        job.last_run_at === null
          ? "Failed"
          : formatAge(job.last_run_at, snap.value.now),
      cls: "text-red-500 dark:text-red-400",
    };
  }
  if (job.overall_status === "running") {
    const elapsed =
      job.started_at === null
        ? ""
        : ` ${formatDuration(Math.max(0, snap.value.now - job.started_at))}`;

    return {
      text: `Running${elapsed}`,
      cls: "text-sky-600 dark:text-sky-400",
    };
  }
  if (job.overall_status === "pending") {
    return { text: "Pending", cls: "text-dimmed" };
  }

  return {
    text:
      job.last_run_at === null
        ? "Pending"
        : formatAge(job.last_run_at, snap.value.now),
    cls: "text-muted",
  };
}

function jobSummaryText(job: JobSummary): string {
  if (job.overall_status === "overdue") {
    if (job.last_run_at === null) {
      return "Never reported";
    }

    return `Last finished ${formatAge(job.last_run_at, snap.value.now)}${job.last_summary ? ` (${job.last_summary})` : ""}`;
  }
  if (job.overall_status === "pending") {
    return "Waiting for first report";
  }

  return job.last_summary ?? job.last_status;
}

const onRotatePing = (job: JobSummary) =>
  run(`rotate:${job.key}`, "Rotation failed", async () => {
    const res = await apiFetch<{ key: string; ping_url: string }>(
      `/api/v1/admin/jobs/${encodeURIComponent(job.key)}/rotate-token`,
      "POST",
    );
    onIssuedPing({
      key: res.key,
      label: job.label,
      pingUrl: res.ping_url,
    });
  });

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
    <DefineJobActions v-slot="{ job }">
      <MuteButton
        class="font-sans"
        :label="job.label"
        :muted-until="job.muted_until"
        :now="snap.now"
        :target-id="job.key"
        target-type="job"
      />
      <template v-if="!job.managed_by_node_id">
        <UButton
          aria-label="Edit job"
          class="font-sans"
          color="neutral"
          icon="i-lucide-pencil"
          size="xs"
          variant="ghost"
          @click="openJobModal(job)"
        />
        <ConfirmPopover
          class="font-sans"
          confirm-color="primary"
          confirm-label="Rotate"
          label="Rotate URL"
          :loading="busy === `rotate:${job.key}`"
          @confirm="onRotatePing(job)"
        >
          Rotate ping URL for
          <strong>{{ job.label }}</strong>
          ? The current URL will stop working.
        </ConfirmPopover>
        <ConfirmPopover
          class="font-sans"
          label="Remove"
          :loading="busy === job.key"
          @confirm="onRemoveJob(job.key)"
        >
          Remove
          <strong>{{ job.label }}</strong>
          ?
        </ConfirmPopover>
      </template>
    </DefineJobActions>

    <PageHeader title="Jobs">
      <UButton
        color="primary"
        icon="i-lucide-plus"
        size="xs"
        @click="openJobModal(null)"
      >
        Add job
      </UButton>
    </PageHeader>

    <EmptyState v-if="snap.jobs.length === 0">
      No jobs yet. Create a push job for a ping URL, or emit
      <code class="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
        jobs[]
      </code>
      from an agent collector.
    </EmptyState>

    <div v-else class="divide-y divide-default border-y border-default">
      <div v-for="job in snap.jobs" :key="job.key" class="space-y-2 py-4">
        <div class="flex items-start justify-between gap-3">
          <div class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <StatusDot :status="job.overall_status" />
            <span class="text-sm font-semibold">{{ job.label }}</span>
            <span
              v-if="job.label.toLowerCase() !== job.key.toLowerCase()"
              class="hidden font-mono text-xs text-dimmed sm:inline"
            >
              {{ job.key }}
            </span>
            <RouterLink
              v-if="job.node_id"
              class="inline-flex items-center gap-1 font-mono text-xs text-muted transition-colors hover:text-primary"
              :to="`/admin/nodes/${encodeURIComponent(job.node_id)}`"
            >
              <UIcon
                class="size-3 shrink-0 text-dimmed"
                name="i-lucide-server"
              />
              <span>on {{ job.node_id }}</span>
            </RouterLink>
            <span v-else class="font-mono text-xs text-dimmed">Push ping</span>
            <MutedBadge :now="snap.now" :until="job.muted_until" />
          </div>

          <div
            class="flex shrink-0 items-center gap-2 pt-0.5 font-mono text-xs tabular-nums sm:pt-0"
          >
            <span :class="statusTiming(job).cls">
              {{ statusTiming(job).text }}
            </span>

            <div class="hidden items-center gap-1 sm:flex">
              <JobActions :job />
            </div>
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
            {{ jobSummaryText(job) }}
          </span>
          <div
            v-if="jobScheduleParts(job).length > 0"
            class="hidden shrink-0 items-center gap-3 font-mono text-[11px] text-dimmed tabular-nums sm:inline-flex"
          >
            <span v-for="part in jobScheduleParts(job)" :key="part">
              {{ part }}
            </span>
          </div>
        </div>

        <div
          class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 pl-4 sm:hidden"
        >
          <div
            class="inline-flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-[11px] text-dimmed tabular-nums"
          >
            <span v-for="part in jobScheduleParts(job)" :key="part">
              {{ part }}
            </span>
          </div>
          <div class="flex shrink-0 items-center gap-1">
            <JobActions :job />
          </div>
        </div>

        <pre
          v-if="job.last_detail"
          class="ml-4 max-h-56 overflow-auto rounded-lg bg-muted p-3 font-mono text-xs leading-relaxed"
          >{{ job.last_detail }}</pre>
      </div>
    </div>

    <JobModal
      v-model:open="jobModalOpen"
      :job="editingJob"
      @issued="onIssuedPing"
    />
    <JobPingModal v-model:open="pingModalOpen" :issued="issuedPing" />
  </div>
</template>
