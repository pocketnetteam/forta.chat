/** WEE-99: filters for noisy room-setup system events.
 *
 *  Matches legacy bastyon-chat behavior (events/event/member/index.js):
 *  - m.room.power_levels renders only when the users map actually changed
 *    vs unsigned.prev_content (moderator marked/unmarked), otherwise hidden;
 *  - service room names (creation-time hex hash / empty) are hidden;
 *  - the room-creation burst (creator's own join, initial invite, initial
 *    power_levels, avatar set at creation) is hidden.
 */

/** Power level treated as "moderator" (mirrors bastyon-chat's check). */
const MODERATOR_LEVEL = 50;

/** Events this close to m.room.create are part of the creation burst. */
export const ROOM_CREATION_BURST_WINDOW_MS = 60_000;

export interface ModeratorChange {
  /** Raw matrix user id whose level changed. */
  userId: string;
  /** true → marked as moderator, false → unmarked. */
  promoted: boolean;
}

/** Diff the `users` maps of an m.room.power_levels event vs its
 *  unsigned.prev_content. Returns the first moderator change, or null when
 *  nothing user-visible happened (initial power_levels has no prev_content;
 *  non-user permission tweaks produce no diff). */
export const getModeratorChange = (
  content: Record<string, unknown> | undefined,
  prevContent: Record<string, unknown> | undefined,
): ModeratorChange | null => {
  if (!prevContent) return null;
  const users = (content?.users ?? {}) as Record<string, number>;
  const prevUsers = (prevContent.users ?? {}) as Record<string, number>;
  const defaultLevel = typeof content?.users_default === "number" ? content.users_default : 0;
  const prevDefaultLevel = typeof prevContent.users_default === "number" ? prevContent.users_default : 0;

  for (const id of new Set([...Object.keys(users), ...Object.keys(prevUsers)])) {
    const level = users[id] ?? defaultLevel;
    const prevLevel = prevUsers[id] ?? prevDefaultLevel;
    if (level === prevLevel) continue;
    // Mirror bastyon-chat: only the moderator transition is user-visible;
    // other level changes (e.g. creator 100 at setup) stay hidden.
    if (level >= MODERATOR_LEVEL && prevLevel < MODERATOR_LEVEL) return { userId: id, promoted: true };
    if (level < MODERATOR_LEVEL && prevLevel >= MODERATOR_LEVEL) return { userId: id, promoted: false };
  }
  return null;
};

/** Service room names assigned at creation: empty or a long hex hash. */
export const isServiceRoomName = (name: string): boolean =>
  !name || /^#?[0-9a-f]{20,}$/i.test(name);

/** True when the event happened within the room-creation burst window. */
export const isWithinCreationBurst = (
  eventTs: number,
  roomCreationTs: number | null,
): boolean =>
  roomCreationTs != null
  && eventTs >= roomCreationTs - ROOM_CREATION_BURST_WINDOW_MS
  && eventTs - roomCreationTs <= ROOM_CREATION_BURST_WINDOW_MS;

/** Member events that are part of the creation burst and should be hidden:
 *  the creator's own join and the initial invite. Later joins/invites
 *  (outside the window) stay visible. */
export const isCreationBurstMemberEvent = (
  membership: string,
  isSelf: boolean,
  eventTs: number,
  roomCreationTs: number | null,
): boolean =>
  isWithinCreationBurst(eventTs, roomCreationTs)
  && ((membership === "join" && isSelf) || membership === "invite");
