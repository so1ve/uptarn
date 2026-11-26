import { useStorage } from "@vueuse/core";
import type { Ref } from "vue";
import { reactive, ref, watch } from "vue";

import type { TargetType } from "../../../src/shared/index.ts";
import {
  PERMANENT_MUTE_UNTIL,
  errorMessage,
  formatDuration,
} from "../../../src/shared/index.ts";
import { apiFetch } from "../lib/api.ts";
import { useUptarnStore } from "../lib/store.ts";
import type { MonitorWindow } from "../lib/telemetry.ts";

export function useAction() {
  const toast = useToast();
  const { refreshSnapshot } = useUptarnStore();
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
    duration: number | "forever",
  ) =>
    run(
      key,
      "Failed to update mute",
      async () => {
        await apiFetch(
          "/api/v1/admin/mute",
          "POST",
          duration === "forever"
            ? {
                target_type: targetType,
                target_id: targetId,
                muted_until: PERMANENT_MUTE_UNTIL,
              }
            : {
                target_type: targetType,
                target_id: targetId,
                duration_secs: duration,
              },
        );

        if (duration === "forever") {
          return `Muted ${label} forever`;
        }

        return duration > 0
          ? `Muted ${label} for ${formatDuration(duration)}`
          : `Resumed notifications for ${label}`;
      },
      true,
    );

  return { busy, run, copy, mute };
}

export function useModalForm<T extends object>(
  open: Ref<boolean>,
  createInitial: () => T,
): T {
  const form = reactive(createInitial()) as T;
  watch(open, (isOpen) => {
    if (isOpen) {
      Object.assign(form, createInitial());
    }
  });

  return form;
}

export const useMonitorWindow = () =>
  useStorage<MonitorWindow>("uptarn:monitor-window", "24h");
