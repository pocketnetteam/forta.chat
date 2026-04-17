import { hexDecode } from "@/shared/lib/matrix/functions";
import { cleanMatrixIds, formatGroupMemberNames, isUnresolvedName } from "./chat-helpers";
import { tRaw } from "@/shared/lib/i18n";
import type { ChatRoom } from "../model/types";

const hexDecodeCache = new Map<string, string>();
function cachedHexDecode(hex: string): string {
  let result = hexDecodeCache.get(hex);
  if (result === undefined) {
    result = hexDecode(hex);
    hexDecodeCache.set(hex, result);
  }
  return result;
}

/**
 * Member display names for room title (Pocketnet profile → Matrix display name).
 * Same rules as the chat list (ContactList).
 */
export function resolveMemberNamesForRoomTitle(
  room: ChatRoom,
  allUsers: Record<string, { name?: string; deleted?: boolean } | undefined>,
  myHexId: string,
  getDisplayName: (bastyonAddress: string) => string,
): string[] {
  const otherMembers = room.members.filter(m => m !== myHexId);
  const names: string[] = [];
  for (const hexId of otherMembers) {
    const addr = cachedHexDecode(hexId);
    if (/^[A-Za-z0-9]+$/.test(addr)) {
      const user = allUsers[addr];
      if (user?.deleted) {
        names.push(tRaw("profile.deletedAccount"));
        continue;
      }
      if (user?.name && !isUnresolvedName(user.name) && user.name !== addr) {
        names.push(user.name);
        continue;
      }
      const matrixName = getDisplayName(addr);
      if (matrixName && matrixName !== addr && matrixName !== "?" && !isUnresolvedName(matrixName)) {
        names.push(matrixName);
        continue;
      }
    }
  }
  if (names.length === 0 && room.avatar?.startsWith("__pocketnet__:")) {
    const avatarAddr = room.avatar.slice("__pocketnet__:".length);
    const user = allUsers[avatarAddr];
    if (user?.deleted) {
      names.push(tRaw("profile.deletedAccount"));
    } else if (user?.name && !isUnresolvedName(user.name) && user.name !== avatarAddr) {
      names.push(user.name);
    } else {
      const matrixName = getDisplayName(avatarAddr);
      if (matrixName && matrixName !== avatarAddr && matrixName !== "?" && !isUnresolvedName(matrixName)) {
        names.push(matrixName);
      }
    }
  }
  return names;
}

/**
 * Room title string for sidebar / header / search — must match ContactList `roomNameMap`.
 */
export function resolveRoomDisplayName(
  room: ChatRoom,
  allUsers: Record<string, { name?: string; deleted?: boolean } | undefined>,
  myHexId: string,
  getDisplayName: (bastyonAddress: string) => string,
): string {
  if (!room.isGroup) {
    const names = resolveMemberNamesForRoomTitle(room, allUsers, myHexId, getDisplayName);
    if (names.length > 0) return names.join(", ");
    return cleanMatrixIds(room.name);
  }
  if (room.name?.startsWith("@")) return room.name.slice(1);
  if (!isUnresolvedName(room.name)) return cleanMatrixIds(room.name);
  const names = resolveMemberNamesForRoomTitle(room, allUsers, myHexId, getDisplayName);
  if (names.length > 0) return formatGroupMemberNames(names);
  if (room.avatar?.startsWith("__pocketnet__:")) {
    return room.avatar.slice("__pocketnet__:".length);
  }
  const otherMembers = room.members.filter(m => m !== myHexId);
  if (otherMembers.length > 0) {
    const addr = cachedHexDecode(otherMembers[0]);
    if (/^[A-Za-z0-9]+$/.test(addr)) return addr;
  }
  return cleanMatrixIds(room.name);
}
