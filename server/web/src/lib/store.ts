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

let snapshotRefreshPromise: Promise<void> | null = null;
let snapshotRefreshSeq = 0;
let lastSnapshotFetchedAt = 0;

let publicRefreshPromise: Promise<void> | null = null;
let publicRefreshSeq = 0;
let lastPublicFetchedAt = 0;

const colorMode = useColorMode();
const isDark = computed(() => colorMode.value === "dark");

function toggleTheme() {
  colorMode.value = colorMode.value === "dark" ? "light" : "dark";
}

async function loadState() {
  loadError.value = null;
  try {
    const boot = await apiFetch<BootPayload>("/api/v1/boot");
    const now = Date.now();
    if (boot.mode === "admin") {
      snapshot.value = boot.snapshot;
      publicStatus.value = null;
      lastSnapshotFetchedAt = now;
    } else {
      snapshot.value = null;
      publicStatus.value = boot.status;
      lastPublicFetchedAt = now;
    }
  } catch (err) {
    loadError.value = errorMessage(err);
  }
}

async function refreshSnapshot(options: { force?: boolean } = {}) {
  if (!options.force && snapshotRefreshPromise) {
    return snapshotRefreshPromise;
  }

  const seq = ++snapshotRefreshSeq;
  const task = (async () => {
    try {
      const next = await apiFetch<DashboardSnapshot>("/api/v1/admin/snapshot");
      if (seq === snapshotRefreshSeq) {
        snapshot.value = next;
        lastSnapshotFetchedAt = Date.now();
        if (options.force) {
          syncGeneration.value += 1;
        }
      }
    } catch (err) {
      if (
        seq === snapshotRefreshSeq &&
        err instanceof ApiError &&
        err.status === 401
      ) {
        await loadState();
      }
    } finally {
      if (seq === snapshotRefreshSeq) {
        snapshotRefreshPromise = null;
      }
    }
  })();

  snapshotRefreshPromise = task;

  return task;
}

async function refreshPublicStatus(options: { force?: boolean } = {}) {
  if (!options.force && publicRefreshPromise) {
    return publicRefreshPromise;
  }

  const seq = ++publicRefreshSeq;
  const task = (async () => {
    try {
      const next = await apiFetch<PublicStatusSnapshot>(
        "/api/v1/public/status",
      );
      if (seq === publicRefreshSeq) {
        publicStatus.value = next;
        lastPublicFetchedAt = Date.now();
      }
    } catch {
      // Keep existing snapshot visible on transient network blips.
    } finally {
      if (seq === publicRefreshSeq) {
        publicRefreshPromise = null;
      }
    }
  })();

  publicRefreshPromise = task;

  return task;
}

export function useLiveRefresh(
  kind: "admin" | "public",
  intervalMs = 10_000,
  focusDebounceMs = 3000,
) {
  const trigger = () =>
    kind === "admin" ? refreshSnapshot() : refreshPublicStatus();
  const lastFetchedAt = () =>
    kind === "admin" ? lastSnapshotFetchedAt : lastPublicFetchedAt;

  useIntervalFn(() => {
    if (!document.hidden) {
      void trigger();
    }
  }, intervalMs);

  function onFocusOrVisible() {
    if (document.hidden) {
      return;
    }
    if (Date.now() - lastFetchedAt() < focusDebounceMs) {
      return;
    }
    void trigger();
  }

  useEventListener(document, "visibilitychange", onFocusOrVisible);
  useEventListener(window, "focus", onFocusOrVisible);
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
          : `Resumed alerts for ${label}`;
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

async function persistOrder(kind: "nodes" | "monitors", ids: string[]) {
  if (!snapshot.value) {
    return;
  }
  const prevNodes = snapshot.value.nodes;
  const prevMonitors = snapshot.value.monitors;
  snapshot.value =
    kind === "nodes"
      ? { ...snapshot.value, nodes: sortByOrder(prevNodes, ids) }
      : { ...snapshot.value, monitors: sortByOrder(prevMonitors, ids) };
  try {
    await apiFetch(`/api/v1/admin/${kind}/order`, "PUT", { ids });
  } catch (err) {
    if (snapshot.value) {
      snapshot.value =
        kind === "nodes"
          ? { ...snapshot.value, nodes: prevNodes }
          : { ...snapshot.value, monitors: prevMonitors };
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
