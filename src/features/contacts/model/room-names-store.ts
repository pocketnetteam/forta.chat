import { computed } from "vue";
import { defineStore } from "pinia";
import { useChatStore } from "@/entities/chat";
import { useAuthStore } from "@/entities/auth";
import { useUserStore } from "@/entities/user/model";
import { hexEncode } from "@/shared/lib/matrix/functions";
import { createRoomNameIndex } from "../lib/room-name-index";
import { resolveRoomNameInfo, type NameContext } from "../lib/resolve-room-name";

/**
 * Resolved chat-list titles, shared by every mounted ContactList.
 *
 * SwipeableTabs keeps all tabs (all / personal / groups / invites) mounted, and each list
 * used to build its own name index over the whole `sortedRooms` — thousands of rooms with
 * invites — so the cold-start resolution ran once per tab inside one long task. One store,
 * one memo, one pass.
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

  const buildRoomNameIndex = createRoomNameIndex<NameContext>(resolveRoomNameInfo);

  /** Room names and unresolved rooms in one pass over the list; both keep their
   *  reference while nothing changed, so the lists / RecycleScroller and the
   *  name-retry watchers don't re-run on every room patch. */
  const roomNameIndex = computed(() => buildRoomNameIndex(chatStore.sortedRooms, nameContext.value));

  return { roomNameIndex };
});
