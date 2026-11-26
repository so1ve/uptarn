import type { Ref } from "vue";
import { computed, ref, watch } from "vue";

import type {
  NodeHistoryResponse,
  NodeSummary,
  SeriesPoint,
} from "../../../src/shared/index.ts";
import { apiFetch } from "../lib/api.ts";
import { hasLiveNodeSamples, useUptarnStore } from "../lib/store.ts";

export const LIVE_WINDOW_SECS = 0;

const DEFAULT_WINDOW_SECS = 21_600;

export function useNodeHistory(
  nodeId: Ref<string>,
  node: Ref<NodeSummary | null>,
) {
  const { syncGeneration, liveHistory } = useUptarnStore();
  const nodeLive = computed(() => liveHistory.value[nodeId.value] ?? null);
  const hasLive = computed(() => hasLiveNodeSamples(nodeId.value));

  const userPicked = ref(false);
  const windowSecs = ref(
    hasLive.value ? LIVE_WINDOW_SECS : DEFAULT_WINDOW_SECS,
  );
  const customHistory = ref<Record<string, SeriesPoint[]> | null>(null);
  const loadingWindow = ref(false);
  let historySeq = 0;
  let lastFetchedAt = 0;
  let lastSyncGen = syncGeneration.value;

  const historyRefreshCooldownMs = (secs: number): number =>
    secs >= 604_800 ? 900_000 : secs >= 86_400 ? 300_000 : 60_000;

  watch(nodeId, () => {
    userPicked.value = false;
    windowSecs.value = hasLive.value ? LIVE_WINDOW_SECS : DEFAULT_WINDOW_SECS;
    customHistory.value = null;
    lastFetchedAt = 0;
  });

  watch(hasLive, (ready) => {
    if (ready && !userPicked.value) {
      windowSecs.value = LIVE_WINDOW_SECS;
    }
  });

  function setWindowSecs(next: number) {
    userPicked.value = true;
    if (next !== windowSecs.value) {
      customHistory.value = null;
      lastFetchedAt = 0;
    }
    windowSecs.value = next;
  }

  // Watch `node.history` (not `last_seen_at`) and throttle background refetches
  // by window granularity so 3s live ticks and 60s polls never spam D1 range scans.
  watch(
    [nodeId, windowSecs, () => node.value?.history, syncGeneration],
    async ([id, secs, , gen]) => {
      if (!id || secs === DEFAULT_WINDOW_SECS || secs === LIVE_WINDOW_SECS) {
        historySeq += 1;
        customHistory.value = null;
        lastFetchedAt = 0;
        loadingWindow.value = false;

        return;
      }
      const forced = gen !== lastSyncGen;
      const isInitial = customHistory.value === null;
      if (!isInitial && !forced) {
        const status = node.value?.overall_status;
        if (
          status === "offline" ||
          status === "pending" ||
          Date.now() - lastFetchedAt < historyRefreshCooldownMs(secs)
        ) {
          return;
        }
      }
      const seq = ++historySeq;
      loadingWindow.value = isInitial;
      try {
        const res = await apiFetch<NodeHistoryResponse>(
          `/api/v1/admin/nodes/${encodeURIComponent(id)}/history?window=${secs}`,
        );
        if (seq === historySeq) {
          customHistory.value = res.history;
          lastFetchedAt = Date.now();
          lastSyncGen = gen;
        }
      } catch {
        // Keep previous series visible on transient fetch failures.
      } finally {
        if (seq === historySeq) {
          loadingWindow.value = false;
        }
      }
    },
  );

  const probeHistory = computed<Record<string, SeriesPoint[]>>(() =>
    windowSecs.value === DEFAULT_WINDOW_SECS ||
    windowSecs.value === LIVE_WINDOW_SECS
      ? (node.value?.history ?? {})
      : (customHistory.value ?? node.value?.history ?? {}),
  );

  const history = computed<Record<string, SeriesPoint[]>>(() =>
    windowSecs.value === LIVE_WINDOW_SECS
      ? (nodeLive.value ?? node.value?.history ?? {})
      : probeHistory.value,
  );

  return {
    windowSecs: computed({
      get: () => windowSecs.value,
      set: setWindowSecs,
    }),
    hasLive,
    loadingWindow,
    history,
    probeHistory,
  };
}
