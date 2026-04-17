import { computed } from "vue";
import { hexDecode, hexEncode } from "@/shared/lib/matrix/functions";
import { isUnresolvedName } from "./chat-helpers";
import { resolveRoomDisplayName } from "./resolve-room-display-name";
import { useChatStore } from "../model/chat-store";
import { useUserStore } from "@/entities/user/model";
import { useAuthStore } from "@/entities/auth";
import type { ChatRoom } from "../model/types";

/**
 * Composable that provides a reactive resolved room name (same string as the chat list).
 * Returns { resolve, isLoading } where isLoading mirrors unreadable hex/Matrix IDs.
 */
export function useResolvedRoomName() {
  const chatStore = useChatStore();
  const userStore = useUserStore();
  const authStore = useAuthStore();

  const myHexId = computed(() => authStore.address ? hexEncode(authStore.address) : "");

  const _enqueuedAddrs = new Set<string>();

  function resolve(room: ChatRoom | null | undefined): string {
    if (!room) return "";
    const result = resolveRoomDisplayName(room, userStore.users, myHexId.value, a => chatStore.getDisplayName(a));

    if (isUnresolvedName(result) && room.members.length > 0) {
      const toLoad: string[] = [];
      for (const hexId of room.members) {
        if (hexId === myHexId.value) continue;
        const addr = hexDecode(hexId);
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

  function isLoading(name: string): boolean {
    return isUnresolvedName(name);
  }

  return { resolve, isLoading };
}
