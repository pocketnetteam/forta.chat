import { computed } from "vue";
import { hexDecode, hexEncode } from "@/shared/lib/matrix/functions";
import { cleanMatrixIds, isUnresolvedName, formatGroupMemberNames } from "./chat-helpers";
import { useChatStore } from "../model/chat-store";
import { useUserStore } from "@/entities/user/model";
import { useAuthStore } from "@/entities/auth";
import { tRaw } from "@/shared/lib/i18n";
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

/** Resolve member names — checks Pocketnet profiles first, then Matrix displaynames.
 *  Matrix displaynames come from m.room.member state events and are available
 *  instantly without any RPC call. */
function resolveMemberNames(room: ChatRoom, allUsers: Record<string, any>, myHexId: string): string[] {
  const chatStore = useChatStore();
  const otherMembers = room.members.filter(m => m !== myHexId);
  const names: string[] = [];
  for (const hexId of otherMembers) {
    const addr = cachedHexDecode(hexId);
    if (/^[A-Za-z0-9]+$/.test(addr)) {
      const user = allUsers[addr];
      if (user?.deleted) { names.push(tRaw("profile.deletedAccount")); continue; }
      if (user?.name && !isUnresolvedName(user.name) && user.name !== addr) {
        names.push(user.name); continue;
      }
      const matrixName = chatStore.getDisplayName(addr);
      if (matrixName && matrixName !== addr && matrixName !== "?" && !isUnresolvedName(matrixName)) {
        names.push(matrixName); continue;
      }
    }
  }
  // Fallback: try avatar address
  if (names.length === 0 && room.avatar?.startsWith("__pocketnet__:")) {
    const avatarAddr = room.avatar.slice("__pocketnet__:".length);
    const user = allUsers[avatarAddr];
    if (user?.deleted) {
      names.push(tRaw("profile.deletedAccount"));
    } else if (user?.name && !isUnresolvedName(user.name) && user.name !== avatarAddr) {
      names.push(user.name);
    } else {
      const matrixName = chatStore.getDisplayName(avatarAddr);
      if (matrixName && matrixName !== avatarAddr && matrixName !== "?" && !isUnresolvedName(matrixName)) {
        names.push(matrixName);
      }
    }
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
  if (names.length > 0) return formatGroupMemberNames(names);
  // Fallback for groups (including mis-flagged 1:1): try avatar address, then member address
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

/**
 * Composable that provides a reactive resolved room name.
 * Returns { resolvedName, isLoading } where isLoading is true when the name
 * is still an unreadable hex/Matrix ID (show skeleton in that case).
 */
export function useResolvedRoomName() {
  const userStore = useUserStore();
  const authStore = useAuthStore();

  const myHexId = computed(() => authStore.address ? hexEncode(authStore.address) : "");

  // Addresses already enqueued for profile loading (avoid repeated calls)
  const _enqueuedAddrs = new Set<string>();

  /** Resolve a room name reactively (depends on userStore.users) */
  function resolve(room: ChatRoom | null | undefined): string {
    if (!room) return "";
    const result = resolveRoom(room, userStore.users, myHexId.value);

    // Proactively request profiles for members when name is still unresolved.
    // ProfileLoader deduplicates and batches, so this is cheap.
    if (isUnresolvedName(result) && room.members.length > 0) {
      const toLoad: string[] = [];
      for (const hexId of room.members) {
        if (hexId === myHexId.value) continue;
        const addr = cachedHexDecode(hexId);
        if (/^[A-Za-z0-9]+$/.test(addr) && !userStore.users[addr]?.name && !_enqueuedAddrs.has(addr)) {
          toLoad.push(addr);
          _enqueuedAddrs.add(addr);
        }
      }
      if (toLoad.length > 0) {
        queueMicrotask(() => userStore.enqueueProfiles(toLoad));
      }
    }

    return result;
  }

  /** Check if a resolved name is still unresolved (should show skeleton) */
  function isLoading(name: string): boolean {
    return isUnresolvedName(name);
  }

  return { resolve, isLoading };
}
