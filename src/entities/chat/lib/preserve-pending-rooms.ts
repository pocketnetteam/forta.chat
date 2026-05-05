import type { ChatRoom } from "../model/types";

/**
 * Grace window for rooms that were locally added (e.g. via `createGroup`)
 * but haven't been delivered to the Matrix SDK by `/sync` yet. The full
 * room refresh otherwise atomically replaces `rooms.value` with whatever
 * the SDK currently knows about — dropping the optimistic entry until the
 * next sync wins it back. With this window the entry stays visible for up
 * to 30s, which covers the worst-case sync latency observed in the field.
 */
export const PENDING_GRACE_MS = 30_000;

interface PreservePendingRoomsArgs {
  /** Current rooms tracked by the store (`rooms.value`). */
  existingRooms: ChatRoom[];
  /** Set of room ids the SDK currently knows about (post-filter). */
  incomingRoomIds: Set<string>;
  /** Reference time used for the grace check. */
  nowMs: number;
}

/**
 * Returns the subset of `existingRooms` that should be preserved despite
 * being absent from the incoming SDK snapshot, because they were added
 * recently enough that the SDK may still be catching up via `/sync`.
 *
 * Pure function — easy to test in isolation. The caller (`fullRoomRefresh`)
 * appends the result to `newRooms` before the atomic publish.
 */
export function preservePendingRooms({
  existingRooms,
  incomingRoomIds,
  nowMs,
}: PreservePendingRoomsArgs): ChatRoom[] {
  const cutoff = nowMs - PENDING_GRACE_MS;
  const out: ChatRoom[] = [];
  for (const r of existingRooms) {
    if (incomingRoomIds.has(r.id)) continue;
    if ((r.updatedAt ?? 0) <= cutoff) continue;
    out.push(r);
  }
  return out;
}
