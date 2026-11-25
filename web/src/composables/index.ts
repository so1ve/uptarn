import { useTitle } from "@vueuse/core";
import type { MaybeRefOrGetter } from "vue";
import { toValue } from "vue";

export * from "./useAction.ts";
export * from "./useNodeHistory.ts";
export * from "./useReorder.ts";

export function usePageTitle(title: MaybeRefOrGetter<string>) {
  useTitle(() => toValue(title), {
    titleTemplate: "%s - Uptarn",
    restoreOnUnmount: false,
  });
}
