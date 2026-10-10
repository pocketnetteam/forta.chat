import { computed } from "vue";
import { defineStore } from "pinia";
import { useChatStore, type ChatRoom } from "@/entities/chat";
import { useAuthStore } from "@/entities/auth";
import { useUserStore } from "@/entities/user/model";
import { hexEncode } from "@/shared/lib/matrix/functions";
import { createRoomNameResolver, type RoomNameInfo } from "../lib/room-name-index";
import { resolveRoomNameInfo, type NameContext } from "../lib/resolve-room-name";

/**
 * Resolved chat-list titles, shared by every mounted ContactList.
 *
 * SwipeableTabs keeps all tabs (all / personal / groups / invites) mounted; they share one
 * memo, so a room shown in several tabs is resolved once. Lists resolve only the rows they
 * display — `sortedRooms` holds thousands of rooms with invites.
 */
export const useRoomNamesStore = defineStore("roomNames", () => {
  const chatStore = useChatStore();
  const authStore = useAuthStore();
  const userStore = useUserStore();

  const nameContext = computed<NameContext>(() => {
    // getDisplayName reads the Matrix display names; track them here, because a
    // memo hit skips the call and with it the dependency.
    void chatStore.userDisplayNames;
    return {
      users: userStore.users,
      aliases: chatStore.localAliases,
      myHexId: authStore.address ? hexEncode(authStore.address) : "",
      getDisplayName: chatStore.getDisplayName,
    };
  });

  const resolveRoom = createRoomNameResolver<NameContext>(resolveRoomNameInfo);

  /** Name of one room, memoized across every list. Call it from a computed / render:
   *  reading the context there makes the caller re-run when a name source changes,
   *  and only the rooms it asks for get resolved again. */
  const resolveInfo = (room: ChatRoom): RoomNameInfo => resolveRoom(room, nameContext.value);

  return { resolveInfo };
});
