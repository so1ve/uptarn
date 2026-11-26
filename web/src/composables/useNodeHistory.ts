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

  watch(nodeId, () => {
    userPicked.value = false;
    windowSecs.value = hasLive.value ? LIVE_WINDOW_SECS : DEFAULT_WINDOW_SECS;
    customHistory.value = null;
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
    }
    windowSecs.value = next;
  }

  // Watch `node.history` (not `last_seen_at`) so 3s live ticks never trigger
  // redundant D1 `/history` fetches when viewing 1h/24h/7d windows.
  watch(
    [nodeId, windowSecs, () => node.value?.history, syncGeneration],
    async ([id, secs]) => {
      const seq = ++historySeq;
      if (!id || secs === DEFAULT_WINDOW_SECS || secs === LIVE_WINDOW_SECS) {
        customHistory.value = null;
        loadingWindow.value = false;

        return;
      }
      loadingWindow.value = customHistory.value === null;
      try {
        const res = await apiFetch<NodeHistoryResponse>(
          `/api/v1/admin/nodes/${encodeURIComponent(id)}/history?window=${secs}`,
        );
        if (seq === historySeq) {
          customHistory.value = res.history;
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
