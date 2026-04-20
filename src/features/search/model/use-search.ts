import { ref, computed } from "vue";
import { useChatStore } from "@/entities/chat";
import type { ChatRoom, Message } from "@/entities/chat";
import { getMatrixClientService } from "@/entities/matrix";
import { useUserStore } from "@/entities/user/model";
import { rankChatRoomsBySearchRelevance } from "./rank-chat-rooms";

export interface MessageSearchResult {
  room: ChatRoom;
  message: Message;
}

export function useSearch() {
  const chatStore = useChatStore();
  const userStore = useUserStore();
  const query = ref("");
  const isSearching = ref(false);

  const chatResults = computed(() => {
    const q = query.value.trim();
    if (!q) return [];
    const qLower = q.toLowerCase();
    const matrix = getMatrixClientService();
    return rankChatRoomsBySearchRelevance(chatStore.sortedRooms, {
      queryLower: qLower,
      getMatrixRoom: (roomId) => {
        const raw = matrix.getRoom(roomId);
        if (!raw || typeof raw !== "object") return null;
        return raw as {
          getJoinRule?: () => string;
          currentState?: { getStateEvents?: (type: string, key: string) => unknown };
          name?: string;
        };
      },
      getMemberNameLower: (address: string) => {
        const u = userStore.getUser(address);
        const raw = (u?.name && String(u.name).trim()) || address;
        return raw.toLowerCase();
      },
    });
  });

  const messageResults = computed((): MessageSearchResult[] => {
    const q = query.value.trim().toLowerCase();
    if (!q || q.length < 2) return [];
    const results: MessageSearchResult[] = [];
    const rooms = chatStore.sortedRooms;
    const messagesMap = chatStore.messagesMap;

    for (const room of rooms) {
      const msgs = messagesMap[room.id];
      if (!msgs) continue;
      for (let i = msgs.length - 1; i >= 0 && results.length < 20; i--) {
        const msg = msgs[i];
        if (msg.content && msg.content.toLowerCase().includes(q)) {
          results.push({ room, message: msg });
        }
      }
      if (results.length >= 20) break;
    }

    results.sort((a, b) => b.message.timestamp - a.message.timestamp);
    return results.slice(0, 20);
  });

  const clearSearch = () => {
    query.value = "";
  };

  return {
    query,
    isSearching,
    chatResults,
    messageResults,
    clearSearch,
  };
}
