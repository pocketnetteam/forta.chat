/**
 * Matrix room utilities — adapted from bastyon-chat/src/application/mtrxkit.js
 *
 * Handles deterministic room ID generation, membership utilities, etc.
 */
import { sha224, getmatrixid, areArraysEqual } from "@/shared/lib/matrix/functions";
import { MATRIX_SERVER } from "@/shared/config";

import type { MatrixClientService } from "./matrix-client";

const cacheStorage: Record<string, string> = {};

export type JoinRule = "public" | "invite" | "knock" | "restricted" | string;

/**
 * Read the raw `m.room.power_levels` event content from a room.
 * Internal helper — used by the resolution chain below.
 */
function readPowerLevelsContent(
  room: Record<string, unknown> | null | undefined,
): { users: Record<string, number>; usersDefault: number } | null {
  if (!room) return null;
  try {
    const cs = (room as { currentState?: { getStateEvents?: (t: string, k?: string) => unknown } }).currentState;
    if (!cs || typeof cs.getStateEvents !== "function") return null;
    const ev = cs.getStateEvents("m.room.power_levels", "");
    const content = (ev as { getContent?: () => Record<string, unknown> } | null)?.getContent?.() ?? {};
    return {
      users: ((content as { users?: Record<string, number> }).users ?? {}) as Record<string, number>,
      usersDefault: typeof (content as { users_default?: number }).users_default === "number"
        ? (content as { users_default: number }).users_default
        : 0,
    };
  } catch {
    return null;
  }
}

/**
 * Extract the local-part (hex/address before `:`) from a Matrix user ID.
 * Returns `null` if the input doesn't look like a Matrix ID.
 */
function extractLocalPart(matrixId: string): string | null {
  if (!matrixId || matrixId[0] !== "@") return null;
  const colon = matrixId.indexOf(":");
  if (colon < 2) return null; // need at least "@x:..."
  return matrixId.slice(1, colon);
}

/**
 * Fuzzy-match a power level by hex local-part across all keys in
 * `m.room.power_levels.users`, regardless of domain.
 *
 * Why: legacy bastyon-chat groups may key admins under a different Matrix
 * homeserver domain (e.g. `@HEX:matrix.bastyon.com`) than Forta currently
 * constructs (`@HEX:matrix.pocketnet.app`). matrix-js-sdk does NOT alias
 * member IDs across domains, so `Room.getMember(...).powerLevel` returns 0
 * for cross-domain admins and the badge stays hidden.
 *
 * This helper bridges that gap: it scans every entry in `users`, extracts the
 * local-part of each key, and returns the level when the local-part matches
 * (case-insensitively) the supplied `hexId`. If multiple keys match (same hex
 * across domains with different PLs), the highest level wins so an admin
 * downgraded on one domain isn't lost.
 *
 * Falls back to `users_default` when no key matches, then `0`.
 */
export function getPowerLevelByHexId(
  room: Record<string, unknown> | null | undefined,
  hexId: string,
): number {
  if (!room || !hexId) return 0;
  const pl = readPowerLevelsContent(room);
  if (!pl) return 0;

  const wantHex = hexId.toLowerCase();
  let best: number | null = null;

  for (const key in pl.users) {
    const local = extractLocalPart(key);
    if (local && local.toLowerCase() === wantHex) {
      const level = pl.users[key];
      if (typeof level === "number") {
        if (best === null || level > best) best = level;
      }
    }
  }

  return best ?? pl.usersDefault;
}

/**
 * Read the creator of a room from `m.room.create`.
 *
 * For room versions ≤ 10, the creator is the `creator` field in the event
 * content. For room version 11+, the field was removed and the creator is
 * inferred from the event sender (which is always the creator since
 * `m.room.create` is the first event in the room).
 *
 * Why this matters: per Matrix spec, when `m.room.power_levels.users` does
 * not list a user, that user gets `users_default` — UNLESS they are the
 * creator and the room either has no power_levels event or the event was
 * created with empty `users`. Some legacy bastyon-chat groups (and even
 * some new Forta-created rooms with `room_version: "10"` we observed in
 * production) end up with an empty power_levels.users, leaving the creator
 * with PL 0 unless we apply the implicit-creator rule ourselves.
 * matrix-js-sdk's RoomMember.powerLevel does not perform this fallback.
 */
export function getRoomCreator(
  room: Record<string, unknown> | null | undefined,
): string | null {
  if (!room) return null;
  try {
    const cs = (room as { currentState?: { getStateEvents?: (t: string, k?: string) => unknown } }).currentState;
    if (!cs || typeof cs.getStateEvents !== "function") return null;
    const ev = cs.getStateEvents("m.room.create", "");
    if (!ev) return null;
    const content = (ev as { getContent?: () => Record<string, unknown> }).getContent?.() ?? {};
    const creatorField = (content as { creator?: string }).creator;
    if (typeof creatorField === "string" && creatorField.length > 0) return creatorField;
    // Room version 11+ — creator inferred from event sender.
    const sender = (ev as { getSender?: () => string | null }).getSender?.() ?? null;
    if (typeof sender === "string" && sender.length > 0) return sender;
    return null;
  } catch {
    return null;
  }
}

/**
 * Compare two Matrix user IDs by their hex local-part (case-insensitive).
 * Cross-domain safe — `@hex:matrix.bastyon.com` matches `@hex:matrix.pocketnet.app`.
 */
function sameUserByHexLocal(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const la = extractLocalPart(a)?.toLowerCase();
  const lb = extractLocalPart(b)?.toLowerCase();
  return !!la && !!lb && la === lb;
}

/**
 * Read my power level in a room with four-stage resolution:
 *
 * 1. **SDK direct**: `Room.getMember(myUserId).powerLevel` — the canonical
 *    path. Works for current-domain admins and Forta-created rooms.
 *
 * 2. **Fuzzy hex match**: scan `m.room.power_levels.users` keys for any
 *    entry whose local-part matches the hex of `myUserId`, regardless of
 *    domain. Salvages legacy bastyon-chat admins whose power_levels entry
 *    was written under a foreign domain (`matrix.bastyon.com`,
 *    `matrix.bastyon.io`, etc.). matrix-js-sdk does no cross-domain alias
 *    resolution, so this final-mile fallback is necessary for badge
 *    correctness in old rooms.
 *
 * 3. **Creator implicit**: per Matrix spec, when `power_levels.users` does
 *    not list the creator (including the empty-map case), the creator gets
 *    PL 100. matrix-js-sdk does not apply this rule via RoomMember.powerLevel.
 *    Compared by hex local-part so cross-domain creator IDs match.
 *
 * 4. **`users_default`**: when nothing matches, return the room's default
 *    level (0 in standard rooms, sometimes 50 in legacy bastyon-chat groups
 *    that opted into broader baseline permissions).
 */
export function getMyPowerLevel(
  room: Record<string, unknown> | null | undefined,
  myUserId: string,
): number {
  if (!room || !myUserId) return 0;
  // Stage 1: canonical SDK path.
  let sdkLevel: number | null = null;
  try {
    const getMember = (room as { getMember?: (id: string) => { powerLevel?: number } | null }).getMember;
    const member = typeof getMember === "function" ? getMember.call(room, myUserId) : null;
    if (member && typeof member.powerLevel === "number") {
      sdkLevel = member.powerLevel;
      if (sdkLevel !== 0) return sdkLevel;
    }
  } catch {
    /* fall through */
  }
  // Stage 2: fuzzy hex match across power_levels.users (cross-domain admins).
  try {
    const localPart = extractLocalPart(myUserId);
    if (localPart) {
      const fuzzy = getPowerLevelByHexId(room, localPart);
      if (fuzzy !== 0) return fuzzy;
    }
  } catch {
    /* fall through */
  }
  // Stage 3: implicit creator. Per Matrix spec, creator has PL 100 when
  // power_levels.users does not list them — including the empty-map case
  // we observed in production for some legacy and even some new groups.
  try {
    const creator = getRoomCreator(room);
    if (sameUserByHexLocal(creator, myUserId)) return 100;
  } catch {
    /* fall through */
  }
  // Stage 4: SDK had the member with explicit 0 → respect that.
  if (sdkLevel !== null) return sdkLevel;
  // Stage 5: read users_default as last resort.
  const pl = readPowerLevelsContent(room);
  return pl?.usersDefault ?? 0;
}

/**
 * Check whether a user can send a state event of `eventType`. Two-stage:
 *
 * 1. **SDK canonical**: `RoomState.maySendStateEvent`. Authoritative for
 *    rooms whose `power_levels.users` is correctly populated. Short-circuits
 *    on `true`.
 *
 * 2. **Client-side compute with creator implicit**: when SDK says `false`,
 *    re-check with our extended PL resolution (which knows about creator
 *    implicit PL=100, fuzzy hex matches across domains, etc.). If our
 *    effective PL clears the required level for `eventType`, return `true`
 *    and let the server arbitrate. Without this stage, creators of groups
 *    with empty `power_levels.users` get pre-blocked client-side and never
 *    even reach the server — UI buttons silently no-op.
 *
 * The required level for an event type is per Matrix spec:
 *   `power_levels.events[eventType] ?? state_default ?? 50`.
 *
 * Note: this is intentionally optimistic — if the homeserver does not honour
 * the implicit-creator rule, the action will fail server-side with a 403 and
 * the user sees the actual error rather than a silent no-op.
 */
export function canSendStateEvent(
  room: Record<string, unknown> | null | undefined,
  eventType: string,
  myUserId: string,
): boolean {
  if (!room || !myUserId) return false;

  // Stage 1: SDK canonical check.
  try {
    const cs = (room as {
      currentState?: { maySendStateEvent?: (type: string, userId: string) => boolean };
    }).currentState;
    if (cs && typeof cs.maySendStateEvent === "function") {
      if (cs.maySendStateEvent(eventType, myUserId) === true) return true;
    }
  } catch {
    /* fall through */
  }

  // Stage 2: client-side compute with extended PL resolution.
  try {
    const myLevel = getMyPowerLevel(room, myUserId);
    if (myLevel <= 0) return false;
    const cs2 = (room as {
      currentState?: { getStateEvents?: (t: string, k?: string) => unknown };
    }).currentState;
    let required = 50;
    if (cs2 && typeof cs2.getStateEvents === "function") {
      const ev = cs2.getStateEvents("m.room.power_levels", "");
      const content = (ev as { getContent?: () => Record<string, unknown> } | null)?.getContent?.() ?? {};
      const eventLevels = (content as { events?: Record<string, number> }).events ?? {};
      if (typeof eventLevels[eventType] === "number") {
        required = eventLevels[eventType];
      } else {
        const stateDefault = (content as { state_default?: number }).state_default;
        if (typeof stateDefault === "number") required = stateDefault;
      }
    }
    return myLevel >= required;
  } catch {
    return false;
  }
}

/**
 * Read another room member's power level. Mirrors `getMyPowerLevel`'s
 * four-stage resolution (SDK → fuzzy hex → implicit creator → 0) so admin
 * badges render correctly for cross-domain legacy admins and creators of
 * groups whose `m.room.power_levels.users` ended up empty.
 */
export function getMemberPowerLevel(
  room: Record<string, unknown> | null | undefined,
  matrixUserId: string,
): number {
  if (!room || !matrixUserId) return 0;
  // Stage 1: SDK direct.
  let sdkLevel: number | null = null;
  try {
    const getMember = (room as { getMember?: (id: string) => { powerLevel?: number } | null }).getMember;
    const member = typeof getMember === "function" ? getMember.call(room, matrixUserId) : null;
    if (member && typeof member.powerLevel === "number") {
      sdkLevel = member.powerLevel;
      if (sdkLevel !== 0) return sdkLevel;
    }
  } catch {
    /* fall through */
  }
  // Stage 2: fuzzy hex match (cross-domain admins).
  try {
    const localPart = extractLocalPart(matrixUserId);
    if (localPart) {
      const fuzzy = getPowerLevelByHexId(room, localPart);
      if (fuzzy !== 0) return fuzzy;
    }
  } catch {
    /* fall through */
  }
  // Stage 3: implicit creator (empty power_levels case).
  try {
    const creator = getRoomCreator(room);
    if (sameUserByHexLocal(creator, matrixUserId)) return 100;
  } catch {
    /* fall through */
  }
  // Stage 4: SDK explicit 0 if we saw it; otherwise 0 as default.
  return sdkLevel ?? 0;
}

/**
 * Read `m.room.join_rules` as the single source of truth.
 *
 * Matrix JS SDK exposes two shapes depending on arity of `getStateEvents`:
 *   - `getStateEvents(type, stateKey)` returns a single MatrixEvent | null
 *   - `getStateEvents(type)` returns a MatrixEvent[]
 *
 * Historically chat-store.isRoomPublic and matrix-kit.chatIsPublic read
 * these through different paths → split-brain state. Consolidate here so
 * UI and business logic agree on the rule.
 *
 * Defaults to "invite" (Matrix spec default) when the event is missing or
 * unreadable.
 */
export function readJoinRule(room: Record<string, unknown>): JoinRule {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cs = (room as any)?.currentState;
    if (!cs || typeof cs.getStateEvents !== "function") return "invite";

    // Preferred path: explicit state_key="" returns a single event
    const single = cs.getStateEvents("m.room.join_rules", "");
    if (single && typeof single.getContent === "function") {
      const rule = single.getContent()?.join_rule;
      if (typeof rule === "string" && rule.length > 0) return rule;
    }

    // Fallback path: array shape on some SDK versions
    const arr = cs.getStateEvents("m.room.join_rules");
    if (Array.isArray(arr)) {
      for (const ev of arr) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const e = ev as any;
        const rule = e?.event?.content?.join_rule ?? e?.getContent?.()?.join_rule;
        if (typeof rule === "string" && rule.length > 0) return rule;
      }
    }
  } catch {
    /* fall through to default */
  }
  return "invite";
}

export class MatrixKit {
  private matrixService: MatrixClientService;

  constructor(matrixService: MatrixClientService) {
    this.matrixService = matrixService;
  }

  /** Check if room is a 1:1 (tete-a-tete) chat.
   *  Matches original bastyon-chat mtrxkit.js tetatetchat() behavior exactly:
   *  - Uses ALL members (including "leave"/"ban") for the 2-member check
   *  - Caches result on room.tetatet once sufficient member data exists
   *  - Returns cached value on subsequent calls for crypto stability */
  isTetatetChat(room: Record<string, unknown>): boolean {
    // Cache check — MUST match original: once computed, return cached value.
    // Crypto depends on stable tetatet detection (affects key derivation block param).
    if (typeof room.tetatet !== "undefined") return room.tetatet as boolean;

    // Use ALL members (not just active) — matches original bastyon-chat behavior.
    // The original mtrxkit.js tetatetchat() uses chatUsersInfo() which includes
    // all membership states (join, invite, leave, ban).
    const members = this.getRoomMembers(room);

    const roomName = (room.name as string) ?? "";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const canonicalAlias = ((room as any).getCanonicalAlias?.() as string) ?? "";

    let tt = false;

    // Primary check: exactly 2 members AND room name/alias matches tetatetid hash
    if (members.length === 2) {
      const users = members.map((m) => ({ id: getmatrixid(m.userId as string) }));
      const tid = this.tetatetId(users[0], users[1]);
      if (tid) {
        tt = roomName === "#" + tid || canonicalAlias.indexOf(tid) > -1;
      }
    }

    // Fallback: canonical alias contains a 56-char hex hash (tetatet room pattern)
    if (!tt && canonicalAlias) {
      const aliasMatch = canonicalAlias.match(/^#([a-f0-9]{56}):/);
      if (aliasMatch) tt = true;
    }

    // Last resort: room name is exactly "#" + 56-char hex and NOT public
    if (!tt && roomName.length === 57 && /^#[a-f0-9]{56}$/.test(roomName)) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const joinRule = (room as any).getJoinRule?.() as string;
      if (joinRule !== "public") tt = true;
    }

    // Cache result ONLY when we have enough member data (original: users.length > 1),
    // OR when fallback checks positively identified tetatet.
    if (members.length > 1 || tt) {
      room.tetatet = tt;
    }

    return tt;
  }

  /** Check if room can be interacted with */
  canInteractWithRoom(room: Record<string, unknown>): boolean {
    const interactiveTypes = ["join", "invite"];
    return interactiveTypes.includes(room.selfMembership as string);
  }

  /** Find existing 1:1 room between two users */
  findOneToOneRoom(user1Id: string, user2Id: string): string | undefined {
    const rooms = this.matrixService.getRooms() as Record<string, unknown>[];
    const targetUserIds = [
      this.matrixId(user1Id),
      this.matrixId(user2Id)
    ].sort();

    for (const room of rooms) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const roomAny = room as any;
      const joinRule = (roomAny.getJoinRule?.() as string) ?? "";
      if (joinRule === "public" || !this.canInteractWithRoom(room)) continue;

      const members = (roomAny.getMembers?.() as { userId: string }[]) ?? [];
      if (members.length !== 2) continue;

      const memberIds = members.map((m) => m.userId).sort();
      if (areArraysEqual(memberIds, targetUserIds)) {
        return (room.name as string).replace("#", "");
      }
    }
    return undefined;
  }

  /** Generate deterministic room ID for 1:1 chat */
  tetatetId(user1: { id: string }, user2: { id: string }, version?: number): string | null {
    if (!version) {
      const roomId = this.findOneToOneRoom(user1.id, user2.id);
      if (roomId) return roomId;
    }

    const seed = 2;
    if (user1.id === user2.id) return null;

    const ids = [user1.id, user2.id].sort();
    let id: string = String(parseInt(ids[0], 16) * parseInt(ids[1], 16) * seed);
    if (version) id += "-" + version;

    if (cacheStorage[id]) return cacheStorage[id];

    const hash = sha224(id).toString("hex");
    cacheStorage[id] = hash;
    return hash;
  }

  /** Generate deterministic room ID for group chat (product-based) */
  groupIdEq(users: { id: string }[]): string {
    const seed = 2;
    let id = 1 * seed;
    for (const u of users) {
      id = id * parseInt(u.id, 16);
    }

    const key = String(id);
    if (cacheStorage[key]) return cacheStorage[key];

    const hash = sha224(key).toString("hex");
    cacheStorage[key] = hash;
    return hash;
  }

  /** Check if chat is public. Delegates to the shared readJoinRule helper so
   *  chat-store and this class never diverge on how join_rules is read. */
  chatIsPublic(room: Record<string, unknown>): boolean {
    return readJoinRule(room) === "public";
  }

  /** Get room members — combines currentState.members + summary.members
   *  (matches original bastyon-chat mtrxkit.js usersFromChats) */
  getRoomMembers(room: Record<string, unknown>): Record<string, unknown>[] {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stateMembers = (room as any).currentState?.members as Record<string, Record<string, unknown>> | undefined;
    const members = stateMembers ? Object.values(stateMembers) : [];
    // Also include summary.members (may contain users not in currentState)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const summaryMembers = ((room as any).summary?.members ?? []) as Record<string, unknown>[];
    if (summaryMembers.length === 0) return members;
    // Deduplicate by userId
    const seen = new Set(members.map(m => (m.userId as string)));
    for (const sm of summaryMembers) {
      if (sm.userId && !seen.has(sm.userId as string)) {
        seen.add(sm.userId as string);
        members.push(sm);
      }
    }
    return members;
  }

  /** Extract users from chats for store */
  usersFromChats(rooms: Record<string, unknown>[]): Record<string, { userId: string; membership: string }[]> {
    const users: Record<string, { userId: string; membership: string }[]> = {};
    for (const room of rooms) {
      const roomId = room.roomId as string;
      const members = this.getRoomMembers(room);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const summaryMembers = ((room as any).summary?.members ?? []) as unknown[];

      const allMembers = [...members, ...summaryMembers];
      const seen = new Set<string>();
      users[roomId] = [];

      for (const m of allMembers) {
        const member = m as Record<string, unknown>;
        const userId = getmatrixid(member.userId as string);
        if (seen.has(userId)) continue;
        seen.add(userId);
        users[roomId].push({
          userId,
          membership: member.membership as string
        });
      }
    }
    return users;
  }

  /** Convert address to Matrix user ID */
  matrixId(address: string, domain?: string): string {
    return `@${address}:${domain ?? MATRIX_SERVER}`;
  }
}
