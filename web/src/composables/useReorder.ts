import { ref } from "vue";

import { useUptarnStore } from "../lib/store.ts";
import { useAction } from "./useAction.ts";

function reorderIds(
  ids: readonly string[],
  fromId: string,
  toId: string,
): string[] | null {
  const fromIdx = fromId === toId ? -1 : ids.indexOf(fromId);
  const toIdx = ids.indexOf(toId);
  if (fromIdx === -1 || toIdx === -1) {
    return null;
  }
  const next = [...ids];
  const [moved] = next.splice(fromIdx, 1);
  next.splice(toIdx, 0, moved);

  return next;
}

export function useReorder(
  getIds: () => readonly string[],
  onCommit: (ids: string[]) => void,
  overClass = "bg-elevated/80 ring-1 ring-primary/50",
  getGroup?: (id: string) => string | null,
) {
  const draggingId = ref<string | null>(null);
  const dragOverId = ref<string | null>(null);
  const sameGroup = (a: string, b: string) =>
    !getGroup || getGroup(a) === getGroup(b);

  function onDragEnd() {
    draggingId.value = null;
    dragOverId.value = null;
  }

  function onDragStart(id: string, event: DragEvent) {
    draggingId.value = id;
    dragOverId.value = null;
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", id);
    }
  }

  function onDragOver(id: string, event: DragEvent) {
    if (!draggingId.value || !sameGroup(draggingId.value, id)) {
      return;
    }
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = "move";
    }
    dragOverId.value = draggingId.value === id ? null : id;
  }

  function onDrop(targetId: string, event: DragEvent) {
    event.preventDefault();
    const sourceId =
      draggingId.value ?? event.dataTransfer?.getData("text/plain") ?? null;
    onDragEnd();
    const next =
      sourceId && sameGroup(sourceId, targetId)
        ? reorderIds(getIds(), sourceId, targetId)
        : null;
    if (next) {
      onCommit(next);
    }
  }

  function moveBy(id: string, delta: -1 | 1) {
    const ids = getIds();
    const targetId = ids[ids.indexOf(id) + delta];
    const next =
      targetId && sameGroup(id, targetId)
        ? reorderIds(ids, id, targetId)
        : null;
    if (next) {
      onCommit(next);
    }
  }

  const dragAttrs = (id: string, enabled: boolean) => ({
    draggable: enabled,
    class: [
      draggingId.value === id ? "opacity-45" : "",
      dragOverId.value === id ? overClass : "",
    ],
    onDragend: onDragEnd,
    onDragstart: (e: DragEvent) => enabled && onDragStart(id, e),
    onDragover: (e: DragEvent) => enabled && onDragOver(id, e),
    onDrop: (e: DragEvent) => enabled && onDrop(id, e),
  });

  return { dragAttrs, moveBy };
}

export function usePersistedReorder(
  kind: "nodes" | "monitors",
  getIds: () => readonly string[],
  overClass?: string,
  getGroup?: (id: string) => string | null,
) {
  const { run } = useAction();
  const { persistOrder } = useUptarnStore();
  const label = kind === "nodes" ? "node" : "monitor";
  function commit(ids: string[]) {
    void run(`reorder-${kind}`, `Failed to save ${label} order`, () =>
      persistOrder(kind, ids),
    );
  }

  return { ...useReorder(getIds, commit, overClass, getGroup), commit };
}
