import { useColorMode, useEventListener, useIntervalFn } from "@vueuse/core";
import { computed, onScopeDispose, ref } from "vue";

import type {
  AdminLiveMessage,
  BootPayload,
  DashboardSnapshot,
  LiveNodeSample,
  PublicLiveMessage,
  PublicLiveNodeSample,
  PublicStatusSnapshot,
  SeriesPoint,
} from "../../../src/shared/index.ts";
import {
  MAX_LIVE_POINTS,
  errorMessage,
  memPercent,
  round1,
} from "../../../src/shared/index.ts";
import { ApiError, apiFetch } from "./api.ts";

export interface IssuedToken {
  id: string;
  token: string;
  intervalSecs?: number;
  graceSecs?: number;
}

const LIVE_PING_MS = 25_000;
const LIVE_MIN_BACKOFF_MS = 1500;
const LIVE_MAX_BACKOFF_MS = 30_000;
const LIVE_POLL_FALLBACK_MS = 60_000;

const publicStatus = ref<PublicStatusSnapshot | null>(null);
const snapshot = ref<DashboardSnapshot | null>(null);
const loadError = ref<string | null>(null);
const issuedToken = ref<IssuedToken | null>(null);
const tokenModalOpen = ref(false);
const syncGeneration = ref(0);
const liveConnected = ref(false);
const liveHistory = ref<Record<string, Record<string, SeriesPoint[]>>>({});
const publicLiveHistory = ref<Record<string, Record<string, SeriesPoint[]>>>(
  {},
);

const colorMode = useColorMode();
const isDark = computed(() => colorMode.value === "dark");
const siteTitle = computed(
  () =>
    snapshot.value?.settings.site_title ??
    publicStatus.value?.site_title ??
    null,
);
function toggleTheme() {
  colorMode.value = colorMode.value === "dark" ? "light" : "dark";
}

function appendSeriesPoint(
  points: readonly SeriesPoint[] | undefined,
  ts: number,
  value: number,
): SeriesPoint[] {
  const next = points ? [...points] : [];
  const last = next.at(-1);
  if (last?.ts === ts) {
    next[next.length - 1] = { ts, value };
  } else {
    next.push({ ts, value });
    if (next.length > MAX_LIVE_POINTS) {
      next.splice(0, next.length - MAX_LIVE_POINTS);
    }
  }

  return next;
}

function samplesToSeries(
  samples: readonly LiveNodeSample[],
): Record<string, SeriesPoint[]> {
  const hist: Record<string, SeriesPoint[]> = {};
  for (const s of samples) {
    if (s.cpu_pct !== undefined) {
      (hist._cpu ??= []).push({ ts: s.ts, value: s.cpu_pct });
    }
    if (s.load_1m !== undefined) {
      (hist._load ??= []).push({ ts: s.ts, value: s.load_1m });
    }
    const mem = memPercent({
      uptime_secs: s.uptime_secs,
      mem_used_bytes: s.mem_used_bytes,
      mem_total_bytes: s.mem_total_bytes,
    });
    if (mem !== null) {
      (hist._mem ??= []).push({ ts: s.ts, value: round1(mem) });
    }
    if (s.rx_bps !== null) {
      (hist._rx_bps ??= []).push({ ts: s.ts, value: s.rx_bps });
    }
    if (s.tx_bps !== null) {
      (hist._tx_bps ??= []).push({ ts: s.ts, value: s.tx_bps });
    }
  }

  return hist;
}

function publicSamplesToSeries(
  samples: readonly PublicLiveNodeSample[],
): Record<string, SeriesPoint[]> {
  const hist: Record<string, SeriesPoint[]> = {};
  for (const s of samples) {
    if (s.cpu_pct !== null) {
      (hist._cpu ??= []).push({ ts: s.ts, value: s.cpu_pct });
    }
    if (s.mem_pct !== null) {
      (hist._mem ??= []).push({ ts: s.ts, value: s.mem_pct });
    }
  }

  return hist;
}

function recordAdminSample(sample: LiveNodeSample): void {
  const prev = liveHistory.value[sample.node_id] ?? {};
  const next: Record<string, SeriesPoint[]> = { ...prev };
  if (sample.cpu_pct !== undefined) {
    next._cpu = appendSeriesPoint(prev._cpu, sample.ts, sample.cpu_pct);
  }
  if (sample.load_1m !== undefined) {
    next._load = appendSeriesPoint(prev._load, sample.ts, sample.load_1m);
  }
  const mem = memPercent({
    uptime_secs: sample.uptime_secs,
    mem_used_bytes: sample.mem_used_bytes,
    mem_total_bytes: sample.mem_total_bytes,
  });
  if (mem !== null) {
    next._mem = appendSeriesPoint(prev._mem, sample.ts, round1(mem));
  }
  if (sample.rx_bps !== null) {
    next._rx_bps = appendSeriesPoint(prev._rx_bps, sample.ts, sample.rx_bps);
  }
  if (sample.tx_bps !== null) {
    next._tx_bps = appendSeriesPoint(prev._tx_bps, sample.ts, sample.tx_bps);
  }
  liveHistory.value = { ...liveHistory.value, [sample.node_id]: next };
}

function recordPublicSample(sample: PublicLiveNodeSample): void {
  const prev = publicLiveHistory.value[sample.key] ?? {};
  const next: Record<string, SeriesPoint[]> = { ...prev };
  if (sample.cpu_pct !== null) {
    next._cpu = appendSeriesPoint(prev._cpu, sample.ts, sample.cpu_pct);
  }
  if (sample.mem_pct !== null) {
    next._mem = appendSeriesPoint(prev._mem, sample.ts, sample.mem_pct);
  }
  publicLiveHistory.value = { ...publicLiveHistory.value, [sample.key]: next };
}

function patchAdminNode(snap: DashboardSnapshot, sample: LiveNodeSample): void {
  const idx = snap.nodes.findIndex((n) => n.id === sample.node_id);
  if (idx === -1) {
    return;
  }
  const cur = snap.nodes[idx];
  const nextSystem = {
    ...(cur.system ?? { uptime_secs: sample.uptime_secs }),
    uptime_secs: sample.uptime_secs,
    ...(sample.cpu_pct === undefined ? {} : { cpu_pct: sample.cpu_pct }),
    ...(sample.load_1m === undefined ? {} : { load_1m: sample.load_1m }),
    ...(sample.mem_used_bytes === undefined
      ? {}
      : { mem_used_bytes: sample.mem_used_bytes }),
    ...(sample.mem_total_bytes === undefined
      ? {}
      : { mem_total_bytes: sample.mem_total_bytes }),
  };
  const nextNodes = [...snap.nodes];
  nextNodes[idx] = {
    ...cur,
    last_seen_at: Math.max(cur.last_seen_at ?? 0, sample.ts),
    rx_bps: sample.rx_bps ?? cur.rx_bps,
    tx_bps: sample.tx_bps ?? cur.tx_bps,
    system: nextSystem,
  };
  snapshot.value = {
    ...snap,
    now: Math.max(snap.now, sample.ts),
    nodes: nextNodes,
  };
}

function patchPublicNode(
  status: PublicStatusSnapshot,
  sample: PublicLiveNodeSample,
): void {
  const idx = status.nodes.findIndex((n) => n.key === sample.key);
  if (idx === -1) {
    return;
  }
  const cur = status.nodes[idx];
  const nextNodes = [...status.nodes];
  nextNodes[idx] = {
    ...cur,
    uptime_secs: sample.uptime_secs,
    cpu_pct: sample.cpu_pct ?? cur.cpu_pct,
    mem_pct: sample.mem_pct ?? cur.mem_pct,
  };
  publicStatus.value = {
    ...status,
    now: Math.max(status.now, sample.ts),
    nodes: nextNodes,
  };
}

function applyLiveMessage(
  kind: "admin" | "public",
  msg: AdminLiveMessage | PublicLiveMessage,
): void {
  if (kind === "admin") {
    const adminMsg = msg as AdminLiveMessage;
    if (adminMsg.type === "init") {
      const nextHist: Record<string, Record<string, SeriesPoint[]>> = {};
      for (const [nodeId, samples] of Object.entries(adminMsg.nodes)) {
        nextHist[nodeId] = samplesToSeries(samples);
        const latest = samples.at(-1);
        if (latest && snapshot.value) {
          patchAdminNode(snapshot.value, latest);
        }
      }
      liveHistory.value = nextHist;
    } else if (adminMsg.type === "tick") {
      recordAdminSample(adminMsg.sample);
      if (snapshot.value) {
        patchAdminNode(snapshot.value, adminMsg.sample);
      }
    }

    return;
  }

  const pubMsg = msg as PublicLiveMessage;
  if (pubMsg.type === "init") {
    const nextHist: Record<string, Record<string, SeriesPoint[]>> = {};
    for (const [key, samples] of Object.entries(pubMsg.nodes)) {
      nextHist[key] = publicSamplesToSeries(samples);
      const latest = samples.at(-1);
      if (latest && publicStatus.value) {
        patchPublicNode(publicStatus.value, latest);
      }
    }
    publicLiveHistory.value = nextHist;
  } else if (pubMsg.type === "tick") {
    recordPublicSample(pubMsg.sample);
    if (publicStatus.value) {
      patchPublicNode(publicStatus.value, pubMsg.sample);
    }
  }
}

function handleLiveMessage(kind: "admin" | "public", raw: string): void {
  let msg: AdminLiveMessage | PublicLiveMessage;
  try {
    msg = JSON.parse(raw) as AdminLiveMessage | PublicLiveMessage;
  } catch {
    return;
  }
  applyLiveMessage(kind, msg);
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
  const wsEnabled = typeof WebSocket !== "undefined";
  let socket: WebSocket | null = null;
  let demoUnsub: (() => void) | null = null;
  let demoPending = false;
  let liveSession = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let backoffMs = LIVE_MIN_BACKOFF_MS;
  let disposed = false;
  let focused = document.hasFocus();
  const isWindowActive = (): boolean => !document.hidden && focused;

  function clearTimers() {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (pingTimer !== null) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
  }

  function disconnectLive() {
    liveSession += 1;
    clearTimers();
    liveConnected.value = false;
    demoPending = false;
    if (demoUnsub) {
      demoUnsub();
      demoUnsub = null;
    }
    if (socket) {
      const ws = socket;
      socket = null;
      if (ws.readyState === 0 || ws.readyState === 1) {
        ws.close();
      }
    }
  }

  function connectWebSocketLive() {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const suffix = kind === "public" ? "?scope=public" : "";
    const ws = new WebSocket(`${proto}//${location.host}/api/v1/live${suffix}`);
    socket = ws;

    ws.addEventListener("open", () => {
      if (socket !== ws) {
        return;
      }
      liveConnected.value = true;
      backoffMs = LIVE_MIN_BACKOFF_MS;
      pingTimer = setInterval(() => {
        if (ws.readyState === 1) {
          ws.send("ping");
        }
      }, LIVE_PING_MS);
    });
    ws.addEventListener("message", (event) => {
      if (
        socket === ws &&
        typeof event.data === "string" &&
        event.data !== "pong"
      ) {
        handleLiveMessage(kind, event.data);
      }
    });
    ws.addEventListener("close", () => {
      if (socket !== ws) {
        return;
      }
      disconnectLive();
      if (!disposed && isWindowActive() && reconnectTimer === null) {
        const delay = backoffMs;
        backoffMs = Math.min(LIVE_MAX_BACKOFF_MS, backoffMs * 2);
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          if (!disposed && isWindowActive() && socket === null) {
            connectWebSocketLive();
          }
        }, delay);
      }
    });
    ws.addEventListener("error", () => {
      if (socket === ws) {
        ws.close();
      }
    });
  }

  function startLive() {
    if (import.meta.env.VITE_DEMO === "true") {
      if (demoUnsub || demoPending) {
        return;
      }
      demoPending = true;
      const session = liveSession;
      void import("./demo.ts").then(({ subscribeDemoLive }) => {
        if (disposed || !isWindowActive() || session !== liveSession) {
          return;
        }
        demoPending = false;
        liveConnected.value = true;
        demoUnsub = subscribeDemoLive(kind, (msg) => {
          applyLiveMessage(kind, msg);
        });
      });

      return;
    }
    if (wsEnabled && socket === null) {
      connectWebSocketLive();
    }
  }

  if (isWindowActive()) {
    startLive();
  }

  useIntervalFn(() => {
    if (!isWindowActive()) {
      return;
    }
    // Relax full HTTP polling to 30s while WebSocket live stream is active.
    if (
      liveConnected.value &&
      Date.now() - refresher.lastFetchedAt() < LIVE_POLL_FALLBACK_MS
    ) {
      return;
    }
    void refresher.refresh();
  }, intervalMs);

  function syncActivity() {
    if (!isWindowActive()) {
      disconnectLive();

      return;
    }
    startLive();
    if (Date.now() - refresher.lastFetchedAt() >= focusDebounceMs) {
      void refresher.refresh();
    }
  }

  useEventListener(document, "visibilitychange", () => {
    if (!document.hidden) {
      focused = document.hasFocus();
    }
    syncActivity();
  });
  useEventListener(window, "focus", () => {
    focused = true;
    syncActivity();
  });
  useEventListener(window, "blur", () => {
    focused = false;
    disconnectLive();
  });

  onScopeDispose(() => {
    disposed = true;
    disconnectLive();
  });
}

function showIssuedToken(payload: IssuedToken) {
  issuedToken.value = payload;
  tokenModalOpen.value = true;
  void refreshSnapshot({ force: true });
}

async function signOutState() {
  snapshot.value = null;
  liveHistory.value = {};
  publicLiveHistory.value = {};
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

export function hasLiveNodeSamples(nodeId: string): boolean {
  const live = liveHistory.value[nodeId];
  if (!live) {
    return false;
  }

  return (
    (live._cpu?.length ?? 0) >= 2 ||
    (live._mem?.length ?? 0) >= 2 ||
    (live._load?.length ?? 0) >= 2 ||
    (live._rx_bps?.length ?? 0) >= 2 ||
    (live._tx_bps?.length ?? 0) >= 2
  );
}

export const useUptarnStore = () => ({
  publicStatus,
  snapshot,
  loadError,
  issuedToken,
  tokenModalOpen,
  syncGeneration,
  liveConnected,
  liveHistory,
  publicLiveHistory,
  isDark,
  siteTitle,
  toggleTheme,
  loadState,
  refreshSnapshot,
  refreshPublicStatus,
  showIssuedToken,
  signOutState,
  persistOrder,
});
