import { watch, triggerRef } from "vue";
import { hexEncode } from "@/shared/lib/matrix/functions";
import { useChatStore } from "../model/chat-store";
import { useUserStore } from "@/entities/user/model";
import { useAuthStore } from "@/entities/auth";
import { resolveMemberNamesForRoomTitle } from "./resolve-room-display-name";
import { roomTitleGaveUpIds } from "./room-title-gave-up";

/** When profiles load, drop gave-up if we can now derive member names. */
export function useRoomTitleGaveUpReconcile(): void {
  const chatStore = useChatStore();
  const userStore = useUserStore();
  const authStore = useAuthStore();

  watch(
    () => userStore.users,
    () => {
      if (roomTitleGaveUpIds.value.size === 0) return;
      const myHexId = authStore.address ? hexEncode(authStore.address) : "";
      let changed = false;
      for (const roomId of [...roomTitleGaveUpIds.value]) {
        const room = chatStore.sortedRooms.find(r => r.id === roomId);
        if (!room) continue;
        if (resolveMemberNamesForRoomTitle(room, userStore.users, myHexId, a => chatStore.getDisplayName(a)).length > 0) {
          roomTitleGaveUpIds.value.delete(roomId);
          changed = true;
        }
      }
      if (changed) triggerRef(roomTitleGaveUpIds);
    },
    { deep: false },
  );
}
