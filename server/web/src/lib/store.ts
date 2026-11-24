import { useColorMode } from "@vueuse/core";
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

const colorMode = useColorMode();
const isDark = computed(() => colorMode.value === "dark");

function toggleTheme() {
  colorMode.value = colorMode.value === "dark" ? "light" : "dark";
}

async function loadState() {
  loadError.value = null;
  try {
    const boot = await apiFetch<BootPayload>("/api/v1/boot");
    if (boot.mode === "admin") {
      snapshot.value = boot.snapshot;
      publicStatus.value = null;
    } else {
      snapshot.value = null;
      publicStatus.value = boot.status;
    }
  } catch (err) {
    loadError.value = errorMessage(err);
  }
}

async function refreshSnapshot() {
  try {
    snapshot.value = await apiFetch<DashboardSnapshot>(
      "/api/v1/admin/snapshot",
    );
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      await loadState();
    }
  }
}

async function refreshPublicStatus() {
  try {
    publicStatus.value = await apiFetch<PublicStatusSnapshot>(
      "/api/v1/public/status",
    );
  } catch {
    // Keep existing snapshot visible on transient network blips.
  }
}

function showIssuedToken(payload: IssuedToken) {
  issuedToken.value = payload;
  tokenModalOpen.value = true;
  void refreshSnapshot();
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
        await refreshSnapshot();
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

export const useUptarnStore = () => ({
  publicStatus,
  snapshot,
  loadError,
  issuedToken,
  tokenModalOpen,
  isDark,
  toggleTheme,
  loadState,
  refreshSnapshot,
  refreshPublicStatus,
  showIssuedToken,
  signOutState,
});
