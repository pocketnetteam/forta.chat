import { computed } from "vue";
import { hexDecode, hexEncode } from "@/shared/lib/matrix/functions";
import { cleanMatrixIds, isUnresolvedName } from "./chat-helpers";
import { useChatStore } from "../model/chat-store";
import { useUserStore } from "@/entities/user/model";
import { useAuthStore } from "@/entities/auth";
import type { ChatRoom } from "../model/types";

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

/** Resolve member names for a room from the user store */
function resolveMemberNames(room: ChatRoom, allUsers: Record<string, any>, myHexId: string): string[] {
  const otherMembers = room.members.filter(m => m !== myHexId);
  const names: string[] = [];
  for (const hexId of otherMembers) {
    const addr = cachedHexDecode(hexId);
    if (/^[A-Za-z0-9]+$/.test(addr)) {
      const user = allUsers[addr];
      if (user?.name) { names.push(user.name); continue; }
    }
  }
  // Fallback: try avatar address
  if (names.length === 0 && room.avatar?.startsWith("__pocketnet__:")) {
    const avatarAddr = room.avatar.slice("__pocketnet__:".length);
    const user = allUsers[avatarAddr];
    if (user?.name && user.name !== avatarAddr) names.push(user.name);
  }
  return names;
}

/** Resolve a single room's display name, returning empty string if unresolved */
function resolveRoom(room: ChatRoom, allUsers: Record<string, any>, myHexId: string): string {
  if (!room.isGroup) {
    const names = resolveMemberNames(room, allUsers, myHexId);
    if (names.length > 0) return names.join(", ");
    // Fallback: address from avatar
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
  if (room.name?.startsWith("@")) return room.name.slice(1);
  if (!isUnresolvedName(room.name)) return cleanMatrixIds(room.name);
  const names = resolveMemberNames(room, allUsers, myHexId);
  if (names.length > 0) return names.join(", ");
  return cleanMatrixIds(room.name);
}

/**
 * Composable that provides a reactive resolved room name.
 * Returns { resolvedName, isLoading } where isLoading is true when the name
 * is still an unreadable hex/Matrix ID (show skeleton in that case).
 */
export function useResolvedRoomName() {
  const userStore = useUserStore();
  const authStore = useAuthStore();

  const myHexId = computed(() => authStore.address ? hexEncode(authStore.address) : "");

  /** Resolve a room name reactively (depends on userStore.users) */
  function resolve(room: ChatRoom | null | undefined): string {
    if (!room) return "";
    return resolveRoom(room, userStore.users, myHexId.value);
  }

  /** Check if a resolved name is still unresolved (should show skeleton) */
  function isLoading(name: string): boolean {
    return isUnresolvedName(name);
  }

  return { resolve, isLoading };
}
