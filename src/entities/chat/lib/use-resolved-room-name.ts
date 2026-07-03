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

/** True when `name` is just a truncated/raw address fallback from getDisplayName. */
function isAddressFallbackName(name: string, addr: string): boolean {
  if (!name || name === addr) return true;
  if (addr.length > 16) {
    const truncated = addr.slice(0, 8) + "\u2026" + addr.slice(-4);
    if (name === truncated) return true;
  }
  return false;
}

/** Resolve member names for a room. Honors user-set local aliases (Session 51)
 *  before falling back to Pocketnet profile names — otherwise the alias gets
 *  silently overridden by the Pocketnet displayname in the chat list/header.
 *  `aliases` is read so Vue tracks reactivity at the calling computed. */
function resolveMemberNames(
  room: ChatRoom,
  allUsers: Record<string, any>,
  myHexId: string,
  aliases: Record<string, string>,
  getDisplayName: (address: string) => string,
): string[] {
  const otherMembers = room.members.filter(m => m !== myHexId);
  const names: string[] = [];
  for (const hexId of otherMembers) {
    const addr = cachedHexDecode(hexId);
    if (/^[A-Za-z0-9]+$/.test(addr)) {
      const alias = aliases[addr];
      if (alias) { names.push(alias); continue; }
      const user = allUsers[addr];
      if (user?.name && !isUnresolvedName(user.name) && user.name !== addr) {
        names.push(user.name); continue;
      }
      const matrixName = getDisplayName(addr);
      if (
        matrixName
        && matrixName !== "?"
        && !isUnresolvedName(matrixName)
        && !isAddressFallbackName(matrixName, addr)
      ) {
        names.push(matrixName); continue;
      }
    }
  }
  // Fallback: try avatar address (single-peer DMs with empty members list)
  if (names.length === 0 && room.avatar?.startsWith("__pocketnet__:")) {
    const avatarAddr = room.avatar.slice("__pocketnet__:".length);
    const alias = aliases[avatarAddr];
    if (alias) names.push(alias);
    else {
      const user = allUsers[avatarAddr];
      if (user?.name && !isUnresolvedName(user.name) && user.name !== avatarAddr) {
        names.push(user.name);
      } else {
        const matrixName = getDisplayName(avatarAddr);
        if (
          matrixName
          && matrixName !== "?"
          && !isUnresolvedName(matrixName)
          && !isAddressFallbackName(matrixName, avatarAddr)
        ) {
          names.push(matrixName);
        }
      }
    }
  }
  return names;
}

/** Resolve a single room's display name, returning empty string if unresolved */
function resolveRoom(
  room: ChatRoom,
  allUsers: Record<string, any>,
  myHexId: string,
  aliases: Record<string, string>,
  getDisplayName: (address: string) => string,
): string {
  if (!room.isGroup) {
    const names = resolveMemberNames(room, allUsers, myHexId, aliases, getDisplayName);
    if (names.length > 0) return names.join(", ");
    const avatarAddr = room.avatar?.startsWith("__pocketnet__:")
      ? room.avatar.slice("__pocketnet__:".length)
      : undefined;
    const rawRoomName = room.name ? cleanMatrixIds(room.name) : "";
    if (
      rawRoomName
      && !isUnresolvedName(rawRoomName)
      && (!avatarAddr || (rawRoomName !== avatarAddr && !isAddressFallbackName(rawRoomName, avatarAddr)))
    ) {
      return rawRoomName;
    }
    return "";
  }
  // Group rooms: respect Matrix room name unless it is itself unresolved.
  // Aliases of individual members don't change the group's overall name.
  if (room.name?.startsWith("@")) return room.name.slice(1);
  if (!isUnresolvedName(room.name)) return cleanMatrixIds(room.name);
  const names = resolveMemberNames(room, allUsers, myHexId, aliases, getDisplayName);
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
  const chatStore = useChatStore();

  const myHexId = computed(() => authStore.address ? hexEncode(authStore.address) : "");

  /** Resolve a room name reactively. Tracks userStore.users AND
   *  chatStore.localAliases so changes to either trigger re-render. */
  function resolve(room: ChatRoom | null | undefined): string {
    if (!room) return "";
    return resolveRoom(
      room,
      userStore.users,
      myHexId.value,
      chatStore.localAliases,
      chatStore.getDisplayName,
    );
  }

  /** Check if a resolved name is still unresolved (should show skeleton) */
  function isLoading(name: string): boolean {
    return isUnresolvedName(name);
  }

  return { resolve, isLoading };
}
