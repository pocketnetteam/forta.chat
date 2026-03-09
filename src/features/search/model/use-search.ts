import { ref, computed } from "vue";
import { useChatStore } from "@/entities/chat";
import type { ChatRoom, Message } from "@/entities/chat";

export interface MessageSearchResult {
  room: ChatRoom;
  message: Message;
}

function rankRooms(rooms: ChatRoom[], query: string, pinnedIds: Set<string>): ChatRoom[] {
  const q = query.toLowerCase();
  const scored = rooms
    .filter(r => r.name.toLowerCase().includes(q))
    .map(r => {
      let score = 0;
      if (r.name.toLowerCase().startsWith(q)) score += 100;
      if (pinnedIds.has(r.id)) score += 50;
      const ageMs = Date.now() - r.updatedAt;
      const ageDays = ageMs / (1000 * 60 * 60 * 24);
      score += Math.max(0, 30 - ageDays);
      return { room: r, score };
    });
  scored.sort((a, b) => b.score - a.score);
  return scored.map(s => s.room);
}

export function useSearch() {
  const chatStore = useChatStore();
  const query = ref("");
  const isSearching = ref(false);

  const chatResults = computed(() => {
    const q = query.value.trim();
    if (!q) return [];
    return rankRooms(chatStore.sortedRooms, q, chatStore.pinnedRoomIds);
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
