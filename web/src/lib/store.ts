import { useColorMode, useEventListener, useIntervalFn } from "@vueuse/core";
import { computed, ref } from "vue";

import type {
  BootPayload,
  DashboardSnapshot,
  PublicStatusSnapshot,
} from "../../../src/shared/index.ts";
import { errorMessage } from "../../../src/shared/index.ts";
import { ApiError, apiFetch } from "./api.ts";

export interface IssuedToken {
  id: string;
  token: string;
  intervalSecs?: number;
  graceSecs?: number;
}

const publicStatus = ref<PublicStatusSnapshot | null>(null);
const snapshot = ref<DashboardSnapshot | null>(null);
const loadError = ref<string | null>(null);
const issuedToken = ref<IssuedToken | null>(null);
const tokenModalOpen = ref(false);
const syncGeneration = ref(0);

const colorMode = useColorMode();
const isDark = computed(() => colorMode.value === "dark");
function toggleTheme() {
  colorMode.value = colorMode.value === "dark" ? "light" : "dark";
}

function createRefresher<T>(
  url: string,
  onData: (data: T, force: boolean) => void,
  onError?: (err: unknown) => Promise<void> | void,
) {
  let inFlight: Promise<void> | null = null;
  let seq = 0;
  let lastFetchedAt = 0;

  function refresh(options: { force?: boolean } = {}) {
    if (!options.force && inFlight) {
      return inFlight;
    }
    const id = ++seq;
    const task = (async () => {
      try {
        const next = await apiFetch<T>(url);
        if (id === seq) {
          onData(next, Boolean(options.force));
          lastFetchedAt = Date.now();
        }
      } catch (err) {
        if (id === seq && onError) {
          await onError(err);
        }
      } finally {
        if (id === seq) {
          inFlight = null;
        }
      }
    })();
    inFlight = task;

    return task;
  }

  return {
    refresh,
    markFetched: (ts = Date.now()) => {
      lastFetchedAt = ts;
    },
    lastFetchedAt: () => lastFetchedAt,
  };
}

const adminRefresher = createRefresher<DashboardSnapshot>(
  "/api/v1/admin/snapshot",
  (next, force) => {
    snapshot.value = next;
    if (force) {
      syncGeneration.value += 1;
    }
  },
  async (err) => {
    if (err instanceof ApiError && err.status === 401) {
      await loadState();
    }
  },
);

const publicRefresher = createRefresher<PublicStatusSnapshot>(
  "/api/v1/public/status",
  (next) => {
    loadError.value = null;
    publicStatus.value = next;
  },
  (err) => {
    if (!publicStatus.value) {
      loadError.value = errorMessage(err);
    }
  },
);

const refreshSnapshot = adminRefresher.refresh;
const refreshPublicStatus = publicRefresher.refresh;

async function loadState() {
  loadError.value = null;
  try {
    const boot = await apiFetch<BootPayload>("/api/v1/boot");
    if (boot.mode === "admin") {
      snapshot.value = boot.snapshot;
      publicStatus.value = null;
      adminRefresher.markFetched();
    } else {
      snapshot.value = null;
      publicStatus.value = boot.status;
      publicRefresher.markFetched();
    }
  } catch (err) {
    loadError.value = errorMessage(err);
  }
}

export function useLiveRefresh(
  kind: "admin" | "public",
  intervalMs = 10_000,
  focusDebounceMs = 3000,
) {
  const refresher = kind === "admin" ? adminRefresher : publicRefresher;
  useIntervalFn(() => {
    if (!document.hidden) {
      void refresher.refresh();
    }
  }, intervalMs);

  function onVisible() {
    if (
      !document.hidden &&
      Date.now() - refresher.lastFetchedAt() >= focusDebounceMs
    ) {
      void refresher.refresh();
    }
  }

  useEventListener(document, "visibilitychange", onVisible);
  useEventListener(window, "focus", onVisible);
}

function showIssuedToken(payload: IssuedToken) {
  issuedToken.value = payload;
  tokenModalOpen.value = true;
  void refreshSnapshot({ force: true });
}

async function signOutState() {
  snapshot.value = null;
  await loadState();
}

export const useSnapshot = () => computed(() => snapshot.value!);

function sortByOrder<T extends { id: string }>(
  items: readonly T[],
  ids: readonly string[],
): T[] {
  const rank = new Map(ids.map((id, i) => [id, i]));

  return [...items].sort(
    (a, b) => (rank.get(a.id) ?? 1e9) - (rank.get(b.id) ?? 1e9),
  );
}

async function persistOrder<K extends "nodes" | "monitors">(
  kind: K,
  ids: string[],
  groupUpdate?: { id: string; group: string | null },
) {
  if (!snapshot.value) {
    return;
  }
  const prev = snapshot.value[kind];
  const updated = groupUpdate
    ? prev.map((item) =>
        item.id === groupUpdate.id
          ? { ...item, group: groupUpdate.group }
          : item,
      )
    : prev;
  snapshot.value = {
    ...snapshot.value,
    [kind]: sortByOrder<DashboardSnapshot[K][number]>(updated, ids),
  };
  try {
    const reqs: Promise<unknown>[] = [
      apiFetch(`/api/v1/admin/${kind}/order`, "PUT", { ids }),
    ];
    if (groupUpdate) {
      reqs.push(
        apiFetch(
          `/api/v1/admin/${kind}/${encodeURIComponent(groupUpdate.id)}`,
          "PATCH",
          { group: groupUpdate.group },
        ),
      );
    }
    await Promise.all(reqs);
  } catch (err) {
    if (snapshot.value) {
      snapshot.value = { ...snapshot.value, [kind]: prev };
    }

    throw err;
  }
}

export const useUptarnStore = () => ({
  publicStatus,
  snapshot,
  loadError,
  issuedToken,
  tokenModalOpen,
  syncGeneration,
  isDark,
  toggleTheme,
  loadState,
  refreshSnapshot,
  refreshPublicStatus,
  showIssuedToken,
  signOutState,
  persistOrder,
});
