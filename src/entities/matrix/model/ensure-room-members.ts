import { withTimeout } from "@/shared/lib/with-timeout";

/** Max wait for a room's /members — a send must fail and retry, not hang. */
export const ROOM_MEMBERS_TIMEOUT_MS = 15_000;

/** The part of a matrix-js-sdk Room this module uses. */
export interface LazyMembersRoom {
  roomId?: string;
  membersLoaded?: () => boolean;
  loadMembersIfNeeded?: () => Promise<boolean>;
  clearLoadedMembersIfNeeded?: () => Promise<void>;
  getJoinedMemberCount?: () => number;
  getMyMembership?: () => string;
}

export interface EnsureRoomMembersOptions {
  /** Skip rooms with at least this many joined members (server's count) —
   *  e.g. crypto, which never encrypts them. */
  maxJoined?: number;
  /** Reload a list marked stale by markRoomMembersStale() first. For callers
   *  that derive recipients from it (encryption); display paths keep the
   *  cached list. */
  fresh?: boolean;
  timeoutMs?: number;
}

/** Rooms whose loaded member list may have missed membership changes. */
const staleRooms = new Set<string>();

/**
 * A limited sync omits, with lazy-loaded members, the membership changes of
 * users who did not post in the gap — the room's cached list may be stale (a
 * kicked user would keep getting keys). The next `fresh` ensureRoomMembers
 * reloads it. Not dropped right away: with a 4-event timeline limit resets
 * are routine, and names, calls and filters would lose the peer each time.
 */
export function markRoomMembersStale(roomId: string): void {
  staleRooms.add(roomId);
}

/**
 * Make the room's member list complete when the SDK lazy-loads members.
 *
 * With `lazyLoadMembers: false` the SDK reports every room as loaded
 * (`membersLoaded()` is always true, `loadMembersIfNeeded()` returns a
 * pre-resolved promise, `clearLoadedMembersIfNeeded()` is a no-op), so this
 * makes no network request. With lazy loading on, the first call per room
 * fetches `/members` once; the SDK shares that promise and caches the result.
 *
 * @returns true when members were loaded now, false when nothing was needed.
 * @throws when the load fails or times out (callers that must not proceed
 *   on a partial list — encryption — let it propagate).
 */
export async function ensureRoomMembers(
  room: LazyMembersRoom | null | undefined,
  opts: EnsureRoomMembersOptions = {},
): Promise<boolean> {
  if (!room || typeof room.loadMembersIfNeeded !== "function") return false;
  if (opts.fresh && room.roomId && staleRooms.delete(room.roomId)) {
    await room.clearLoadedMembersIfNeeded?.();
  }
  // Unknown → treat as loaded: never fire requests the SDK did not ask for.
  if (room.membersLoaded?.() !== false) return false;
  // /members needs a joined room — for an invite it only returns 403.
  const membership = room.getMyMembership?.();
  if (membership !== undefined && membership !== "join") return false;
  if (opts.maxJoined !== undefined && (room.getJoinedMemberCount?.() ?? 0) >= opts.maxJoined) return false;
  await withTimeout(room.loadMembersIfNeeded(), opts.timeoutMs ?? ROOM_MEMBERS_TIMEOUT_MS, "loadMembersIfNeeded");
  return true;
}
