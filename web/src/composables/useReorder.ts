import { ref } from "vue";

import { useUptarnStore } from "../lib/store.ts";
import { useAction } from "./useAction.ts";

export interface ReorderMove {
  ids: string[];
  groupUpdate?: { id: string; group: string | null };
}

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

function appendToGroupIds(
  ids: readonly string[],
  sourceId: string,
  groupItemIds: readonly string[],
): string[] | null {
  const fromIdx = ids.indexOf(sourceId);
  if (fromIdx === -1) {
    return null;
  }
  const next = [...ids];
  const [moved] = next.splice(fromIdx, 1);
  const lastTargetId = [...groupItemIds]
    .reverse()
    .find((id) => id !== sourceId);
  if (!lastTargetId) {
    next.push(moved);

    return next;
  }
  const insertAfter = next.indexOf(lastTargetId);
  if (insertAfter === -1) {
    next.push(moved);
  } else {
    next.splice(insertAfter + 1, 0, moved);
  }

  return next;
}

export function useReorder(
  getIds: () => readonly string[],
  onCommit: (move: ReorderMove) => void,
  overClass: string | (() => string) = "bg-elevated/80 ring-1 ring-primary/50",
  getGroup?: (id: string) => string | null,
) {
  const draggingId = ref<string | null>(null);
  const dragOverId = ref<string | null>(null);
  const dragOverGroup = ref<string | null>(null);

  const resolveOverClass = () =>
    typeof overClass === "function" ? overClass() : overClass;

  function onDragEnd() {
    draggingId.value = null;
    dragOverId.value = null;
    dragOverGroup.value = null;
  }

  function onDragStart(id: string, event: DragEvent) {
    draggingId.value = id;
    dragOverId.value = null;
    dragOverGroup.value = null;
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", id);
    }
  }

  function onDragOver(id: string, event: DragEvent) {
    if (!draggingId.value) {
      return;
    }
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = "move";
    }
    dragOverGroup.value = null;
    dragOverId.value = draggingId.value === id ? null : id;
  }

  function commitPair(sourceId: string, targetId: string) {
    const next = reorderIds(getIds(), sourceId, targetId);
    if (!next) {
      return;
    }
    const targetGroup = getGroup?.(targetId) ?? null;
    const groupUpdate =
      getGroup && getGroup(sourceId) !== targetGroup
        ? { id: sourceId, group: targetGroup }
        : undefined;
    onCommit({ ids: next, groupUpdate });
  }

  function onDrop(targetId: string, event: DragEvent) {
    event.preventDefault();
    const sourceId =
      draggingId.value ?? event.dataTransfer?.getData("text/plain") ?? null;
    onDragEnd();
    if (sourceId) {
      commitPair(sourceId, targetId);
    }
  }

  function moveBy(id: string, delta: -1 | 1) {
    const ids = getIds();
    const targetId = ids[ids.indexOf(id) + delta];
    if (targetId) {
      commitPair(id, targetId);
    }
  }

  function onGroupDragOver(
    groupKey: string,
    groupName: string | null,
    event: DragEvent,
  ) {
    if (
      !draggingId.value ||
      !getGroup ||
      getGroup(draggingId.value) === groupName
    ) {
      return;
    }
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = "move";
    }
    dragOverId.value = null;
    dragOverGroup.value = groupKey;
  }

  function onGroupDragLeave(groupKey: string) {
    if (dragOverGroup.value === groupKey) {
      dragOverGroup.value = null;
    }
  }

  function onGroupDrop(
    groupName: string | null,
    groupItemIds: readonly string[],
    event: DragEvent,
  ) {
    event.preventDefault();
    const sourceId =
      draggingId.value ?? event.dataTransfer?.getData("text/plain") ?? null;
    onDragEnd();
    if (!sourceId || !getGroup || getGroup(sourceId) === groupName) {
      return;
    }
    const next = appendToGroupIds(getIds(), sourceId, groupItemIds);
    if (next) {
      onCommit({
        ids: next,
        groupUpdate: { id: sourceId, group: groupName },
      });
    }
  }

  const dragAttrs = (id: string, enabled: boolean) => ({
    draggable: enabled,
    class: [
      draggingId.value === id ? "opacity-45" : "",
      dragOverId.value === id ? resolveOverClass() : "",
    ],
    onDragend: onDragEnd,
    onDragstart: (e: DragEvent) => enabled && onDragStart(id, e),
    onDragover: (e: DragEvent) => enabled && onDragOver(id, e),
    onDrop: (e: DragEvent) => enabled && onDrop(id, e),
  });

  const groupDropAttrs = (
    groupKey: string,
    groupName: string | null,
    groupItemIds: readonly string[],
    enabled: boolean,
  ) => ({
    class:
      dragOverGroup.value === groupKey
        ? "rounded-md bg-elevated/80 px-2 -mx-2 ring-1 ring-primary/50"
        : "",
    onDragover: (e: DragEvent) =>
      enabled && onGroupDragOver(groupKey, groupName, e),
    onDragleave: () => enabled && onGroupDragLeave(groupKey),
    onDrop: (e: DragEvent) =>
      enabled && onGroupDrop(groupName, groupItemIds, e),
  });

  return { dragAttrs, groupDropAttrs, moveBy };
}

export function usePersistedReorder(
  kind: "nodes" | "monitors",
  getIds: () => readonly string[],
  overClass?: string | (() => string),
  getGroup?: (id: string) => string | null,
) {
  const { run } = useAction();
  const { persistOrder } = useUptarnStore();
  const label = kind === "nodes" ? "node" : "monitor";
  function commit(move: ReorderMove | string[]) {
    const normalized: ReorderMove = Array.isArray(move) ? { ids: move } : move;
    void run(`reorder-${kind}`, `Failed to save ${label} order`, () =>
      persistOrder(kind, normalized.ids, normalized.groupUpdate),
    );
  }

  return { ...useReorder(getIds, commit, overClass, getGroup), commit };
}
