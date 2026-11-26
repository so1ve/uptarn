import { useTitle } from "@vueuse/core";
import type { MaybeRefOrGetter } from "vue";
import { toValue } from "vue";

import { useUptarnStore } from "../lib/store.ts";

export * from "./useAction.ts";
export * from "./useNodeHistory.ts";
export * from "./useReorder.ts";

export function usePageTitle(title: MaybeRefOrGetter<string>) {
  const { siteTitle } = useUptarnStore();
  useTitle(() => `${toValue(title)} - ${siteTitle.value || "Uptarn"}`, {
    restoreOnUnmount: false,
  });
}
