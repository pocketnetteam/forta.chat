/**
 * Applies a batch of room changes to the sidebar list in one pass.
 *
 * `sorted` is ordered pinned-first, then by sort key descending. `updates`
 * maps a room id to its new object, or to null to remove it. A room whose new
 * object is the same reference as the one in the list keeps its position.
 *
 * Cost is O(n + k log k) for n rooms and k updates. Per-change findIndex +
 * splice was O(n·k): a sync burst of a few hundred changes on a 5000-room
 * account walked the list hundreds of times.
 *
 * Placement matches one-by-one binary-search insertion: an inserted room goes
 * before existing rooms with an equal key, and of two inserted rooms with an
 * equal key the later update comes first.
 *
 * Returns null when the list does not change.
 */
export function mergeIntoSortedRooms<T extends { id: string }>(
  sorted: readonly T[],
  updates: ReadonlyMap<string, T | null>,
  getSortKey: (room: T) => number,
  pinned: ReadonlySet<string>,
): T[] | null {
  if (updates.size === 0) return null;

  const pending = new Map(updates);
  const kept: T[] = [];
  let removed = false;
  for (const room of sorted) {
    if (!pending.has(room.id)) {
      kept.push(room);
      continue;
    }
    const next = pending.get(room.id);
    if (next === room) {
      kept.push(room);
      pending.delete(room.id);
    } else {
      removed = true;
    }
  }

  const inserts: { room: T; key: number; isPinned: boolean; order: number }[] = [];
  let order = 0;
  for (const room of pending.values()) {
    if (room) inserts.push({ room, key: getSortKey(room), isPinned: pinned.has(room.id), order: order++ });
  }
  if (inserts.length === 0) return removed ? kept : null;

  inserts.sort((a, b) => {
    if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
    if (a.key !== b.key) return b.key - a.key;
    return b.order - a.order;
  });

  const result: T[] = [];
  let i = 0;
  for (const ins of inserts) {
    // Skip past existing rooms that rank strictly before the insert.
    while (i < kept.length) {
      const cur = kept[i];
      const curPinned = pinned.has(cur.id);
      if (curPinned !== ins.isPinned) {
        if (!curPinned) break;
      } else if (getSortKey(cur) <= ins.key) {
        break;
      }
      result.push(cur);
      i++;
    }
    result.push(ins.room);
  }
  while (i < kept.length) result.push(kept[i++]);
  return result;
}
