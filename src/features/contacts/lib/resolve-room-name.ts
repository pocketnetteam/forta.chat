import type { ChatRoom } from "@/entities/chat";
import { hexDecode } from "@/shared/lib/matrix/functions";
import { cleanMatrixIds, isUnresolvedName, MAX_TITLE_MEMBERS } from "@/entities/chat/lib/chat-helpers";
import type { RoomNameInfo } from "./room-name-index";

/** Global sources of member names. A new object whenever any of them changes —
 *  that identity change is what invalidates the room name memo. */
export interface NameContext {
  users: Record<string, { name?: string } | undefined>;
  aliases: Record<string, string>;
  myHexId: string;
  /** Matrix m.room.member displayname for an address. */
  getDisplayName: (address: string) => string;
}

// Cache hexDecode results to avoid repeated computation
const hexDecodeCache = new Map<string, string>();
function cachedHexDecode(hex: string): string {
  let result = hexDecodeCache.get(hex);
  if (result === undefined) {
    result = hexDecode(hex);
    hexDecodeCache.set(hex, result);
  }
  return result;
}

/** Name of one address: local alias → Pocketnet profile → Matrix displayname. */
function resolveAddressName(addr: string, ctx: NameContext): string | null {
  const alias = ctx.aliases[addr];
  if (alias) return alias;
  const user = ctx.users[addr];
  if (user?.name && !isUnresolvedName(user.name) && user.name !== addr) return user.name;
  const matrixName = ctx.getDisplayName(addr);
  if (matrixName && matrixName !== addr && matrixName !== "?" && !isUnresolvedName(matrixName)) {
    return matrixName;
  }
  return null;
}

/** Resolve member names — checks local aliases and Pocketnet profiles first, then
 *  Matrix displaynames (from m.room.member state, free, already in sync).
 *
 *  Walks BOTH joined and invited, otherwise the contact list shows a blank
 *  name for DMs whose peer hasn't accepted the invite yet (`members` would
 *  only contain the inviter). Only the first MAX_TITLE_MEMBERS other members
 *  are taken, joined before invited, in room state order (roughly join order). */
export function resolveMemberNames(room: ChatRoom, ctx: NameContext): string[] {
  const otherMembers: string[] = [];
  for (const list of [room.members, room.invitedMembers ?? []]) {
    for (const m of list) {
      if (otherMembers.length >= MAX_TITLE_MEMBERS) break;
      if (m !== ctx.myHexId) otherMembers.push(m);
    }
  }

  const names: string[] = [];
  for (const hexId of otherMembers) {
    const addr = cachedHexDecode(hexId);
    if (!/^[A-Za-z0-9]+$/.test(addr)) continue;
    const name = resolveAddressName(addr, ctx);
    if (name) names.push(name);
  }

  // Fallback: try avatar address
  if (names.length === 0 && room.avatar?.startsWith("__pocketnet__:")) {
    const name = resolveAddressName(room.avatar.slice("__pocketnet__:".length), ctx);
    if (name) names.push(name);
  }

  return names;
}

/** Resolve room display name — matches original bastyon-chat name.vue:
 *  1. For 1:1: other members' names joined with ", "
 *  2. If no names found → the cleaned room name
 *  3. If room name starts with "@" → strip "@"
 *  4. For groups/public: use room name as-is */
export function resolveRoomName(room: ChatRoom, memberNames: string[]): string {
  if (!room.isGroup) {
    if (memberNames.length > 0) return memberNames.join(", ");
    return cleanMatrixIds(room.name);
  }
  if (room.name?.startsWith("@")) return room.name.slice(1);
  if (!isUnresolvedName(room.name)) return cleanMatrixIds(room.name);
  if (memberNames.length > 0) return memberNames.join(", ");
  return cleanMatrixIds(room.name);
}

/** A group whose own name is shown as-is — member names would be discarded. */
function hasOwnGroupName(room: ChatRoom): boolean {
  return room.isGroup && (!!room.name?.startsWith("@") || !isUnresolvedName(room.name));
}

export function resolveRoomNameInfo(room: ChatRoom, ctx: NameContext): RoomNameInfo {
  // Skip the member walk for named groups: a public room has thousands of members
  // (~35 ms per room) and resolveRoomName ignores their names anyway. The title is
  // final, so the room is not "unresolved" and needs no /members retry.
  if (hasOwnGroupName(room)) return { name: resolveRoomName(room, []), hasMemberNames: true };
  const memberNames = resolveMemberNames(room, ctx);
  return { name: resolveRoomName(room, memberNames), hasMemberNames: memberNames.length > 0 };
}
