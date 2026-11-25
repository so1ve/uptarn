export interface ItemGroup<T> {
  key: string;
  label: string | null;
  isNamed: boolean;
  items: T[];
}

export function groupItems<T>(
  items: readonly T[],
  getGroup: (item: T) => string | null,
): ItemGroup<T>[] {
  if (items.length === 0) {
    return [];
  }
  if (!items.some((item) => getGroup(item) !== null)) {
    return [{ key: "__all__", label: null, isNamed: false, items: [...items] }];
  }

  const buckets = new Map<string, T[]>();
  const ungrouped: T[] = [];
  for (const item of items) {
    const name = getGroup(item);
    if (name) {
      const list = buckets.get(name);
      if (list) {
        list.push(item);
      } else {
        buckets.set(name, [item]);
      }
    } else {
      ungrouped.push(item);
    }
  }

  const result: ItemGroup<T>[] = [...buckets.entries()].map(
    ([name, groupList]) => ({
      key: `g:${name}`,
      label: name,
      isNamed: true,
      items: groupList,
    }),
  );
  if (ungrouped.length > 0) {
    result.push({
      key: "__other__",
      label: "Other",
      isNamed: false,
      items: ungrouped,
    });
  }

  return result;
}

export function collectGroups(
  items: readonly { group: string | null }[],
): string[] {
  const seen = new Set<string>();
  for (const item of items) {
    if (item.group) {
      seen.add(item.group);
    }
  }

  return [...seen];
}

export function reorderNamedGroups<T>(
  groups: readonly ItemGroup<T>[],
  index: number,
  delta: -1 | 1,
  getId: (item: T) => string,
): string[] | null {
  const targetIndex = index + delta;
  const current = groups[index];
  const target = groups[targetIndex];
  if (!current?.isNamed || !target?.isNamed) {
    return null;
  }
  const next = [...groups];
  [next[index], next[targetIndex]] = [next[targetIndex], next[index]];

  return next.flatMap((g) => g.items.map(getId));
}
