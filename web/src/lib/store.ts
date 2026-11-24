import { useColorMode, useEventListener, useIntervalFn } from "@vueuse/core";
import { computed, ref } from "vue";

import type {
  BootPayload,
  DashboardSnapshot,
  PublicStatusSnapshot,
  TargetType,
} from "../../../src/shared/index.ts";
import { formatDuration } from "../../../src/shared/index.ts";
import { ApiError, apiFetch, errorMessage } from "./api.ts";

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
  function trigger() {
    if (!document.hidden) {
      void refresher.refresh();
    }
  }

  useIntervalFn(trigger, intervalMs);

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

export function useAction() {
  const toast = useToast();
  const busy = ref<string | null>(null);

  async function run(
    key: string,
    failTitle: string,
    fn: () => Promise<string | void>,
    refresh = false,
  ): Promise<boolean> {
    busy.value = key;
    try {
      const okTitle = await fn();
      if (okTitle) {
        toast.add({ title: okTitle, color: "success" });
      }
      if (refresh) {
        await refreshSnapshot({ force: true });
      }

      return true;
    } catch (err) {
      toast.add({
        title: failTitle,
        description: errorMessage(err),
        color: "error",
      });

      return false;
    } finally {
      busy.value = null;
    }
  }

  function copy(value: string, label: string) {
    if (!value) {
      return;
    }
    void run(`copy:${label}`, `Could not copy ${label}`, async () => {
      await navigator.clipboard.writeText(value);

      return `${label} copied`;
    });
  }

  const mute = (
    key: string,
    targetType: TargetType,
    targetId: string,
    label: string,
    durationSecs: number,
  ) =>
    run(
      key,
      "Failed to update mute",
      async () => {
        await apiFetch("/api/v1/admin/mute", "POST", {
          target_type: targetType,
          target_id: targetId,
          duration_secs: durationSecs,
        });

        return durationSecs > 0
          ? `Muted ${label} for ${formatDuration(durationSecs)}`
          : `Resumed notifications for ${label}`;
      },
      true,
    );

  return { busy, run, copy, mute };
}

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
) {
  if (!snapshot.value) {
    return;
  }
  const prev = snapshot.value[kind];
  snapshot.value = {
    ...snapshot.value,
    [kind]: sortByOrder<DashboardSnapshot[K][number]>(prev, ids),
  };
  try {
    await apiFetch(`/api/v1/admin/${kind}/order`, "PUT", { ids });
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
