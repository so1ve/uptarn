import { ref } from "vue";

export function reorderIds(
  ids: readonly string[],
  fromId: string,
  toId: string,
): string[] | null {
  if (fromId === toId) {
    return null;
  }
  const fromIdx = ids.indexOf(fromId);
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
) {
  const draggingId = ref<string | null>(null);
  const dragOverId = ref<string | null>(null);

  function onDragStart(id: string, event: DragEvent) {
    draggingId.value = id;
    dragOverId.value = null;
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
    dragOverId.value = draggingId.value === id ? null : id;
  }

  function onDrop(targetId: string, event: DragEvent) {
    event.preventDefault();
    const sourceId =
      draggingId.value ?? event.dataTransfer?.getData("text/plain") ?? null;
    draggingId.value = null;
    dragOverId.value = null;
    if (!sourceId) {
      return;
    }
    const next = reorderIds(getIds(), sourceId, targetId);
    if (next) {
      onCommit(next);
    }
  }

  function onDragEnd() {
    draggingId.value = null;
    dragOverId.value = null;
  }

  function moveBy(id: string, delta: -1 | 1) {
    const ids = getIds();
    const idx = ids.indexOf(id);
    const targetIdx = idx + delta;
    if (idx === -1 || targetIdx < 0 || targetIdx >= ids.length) {
      return;
    }
    const next = reorderIds(ids, id, ids[targetIdx]);
    if (next) {
      onCommit(next);
    }
  }

  return {
    draggingId,
    dragOverId,
    onDragStart,
    onDragOver,
    onDrop,
    onDragEnd,
    moveBy,
  };
}
