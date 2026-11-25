import type { Ref } from "vue";
import { computed, ref, watch } from "vue";

import type {
  NodeHistoryResponse,
  NodeSummary,
  SeriesPoint,
} from "../../../src/shared/index.ts";
import { apiFetch } from "../lib/api.ts";
import { useUptarnStore } from "../lib/store.ts";

const DEFAULT_WINDOW_SECS = 21_600;

export function useNodeHistory(
  nodeId: Ref<string>,
  node: Ref<NodeSummary | null>,
) {
  const { syncGeneration } = useUptarnStore();
  const windowSecs = ref(DEFAULT_WINDOW_SECS);
  const customHistory = ref<Record<string, SeriesPoint[]> | null>(null);
  const loadingWindow = ref(false);
  let historySeq = 0;

  watch(nodeId, () => {
    windowSecs.value = DEFAULT_WINDOW_SECS;
    customHistory.value = null;
  });

  watch(
    [nodeId, windowSecs, () => node.value?.last_seen_at, syncGeneration],
    async ([id, secs]) => {
      const seq = ++historySeq;
      if (!id || secs === DEFAULT_WINDOW_SECS) {
        customHistory.value = null;
        loadingWindow.value = false;

        return;
      }
      loadingWindow.value = true;
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

  const history = computed<Record<string, SeriesPoint[]>>(() =>
    windowSecs.value === DEFAULT_WINDOW_SECS
      ? (node.value?.history ?? {})
      : (customHistory.value ?? node.value?.history ?? {}),
  );

  return { windowSecs, loadingWindow, history };
}
