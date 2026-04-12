import { ref, computed } from "vue";
import { useChatStore } from "@/entities/chat";
import type { ChatRoom, Message } from "@/entities/chat";
import { useUserStore } from "@/entities/user/model";
import { useChannelStore } from "@/entities/channel";
import type { Channel } from "@/entities/channel";
import { hexDecode, hexEncode } from "@/shared/lib/matrix/functions";
import { useAuthStore } from "@/entities/auth";

export interface MessageSearchResult {
  room: ChatRoom;
  message: Message;
}

/**
 * Build a search string for a room: chatName + all member display names.
 * Matches old bastyon-chat AllContacts search behavior exactly:
 * concatenates chatName + userNames into a single lowercase string.
 */
function buildRoomSearchString(
  room: ChatRoom,
  allUsers: Record<string, any>,
  getDisplayName: (addr: string) => string,
  myHexId: string,
): string {
  const parts: string[] = [room.name];

  const otherMembers = room.members.filter(m => m !== myHexId);
  for (const hexId of otherMembers) {
    let addr: string;
    try { addr = hexDecode(hexId); } catch { continue; }
    if (!/^[A-Za-z0-9]+$/.test(addr)) continue;

    const user = allUsers[addr];
    if (user?.name) { parts.push(user.name); continue; }
    const matrixName = getDisplayName(addr);
    if (matrixName && matrixName !== addr && matrixName !== "?") {
      parts.push(matrixName);
    }
  }

  return parts.join("").toLowerCase();
}

/**
 * Rank rooms by old bastyon-chat relevance formula:
 *   point = query.length / searchString.length
 * Higher point = higher in results (shorter matching strings rank higher).
 */
function rankRooms(
  rooms: ChatRoom[],
  query: string,
  allUsers: Record<string, any>,
  getDisplayName: (addr: string) => string,
  myHexId: string,
): ChatRoom[] {
  const q = query.toLowerCase();
  const scored: Array<{ room: ChatRoom; point: number }> = [];

  for (const room of rooms) {
    const searchStr = buildRoomSearchString(room, allUsers, getDisplayName, myHexId);
    if (!searchStr.includes(q)) continue;
    const point = q.length / searchStr.length;
    scored.push({ room, point });
  }

  scored.sort((a, b) => b.point - a.point);
  return scored.map(s => s.room);
}

/**
 * Rank channels by the same relevance formula as rooms.
 */
function rankChannels(channels: Channel[], query: string): Channel[] {
  const q = query.toLowerCase();
  const scored: Array<{ channel: Channel; point: number }> = [];

  for (const ch of channels) {
    const name = ch.name.toLowerCase();
    if (!name.includes(q)) continue;
    const point = q.length / name.length;
    scored.push({ channel: ch, point });
  }

  scored.sort((a, b) => b.point - a.point);
  return scored.map(s => s.channel);
}

export function useSearch() {
  const chatStore = useChatStore();
  const userStore = useUserStore();
  const channelStore = useChannelStore();
  const authStore = useAuthStore();
  const query = ref("");
  const isSearching = ref(false);

  const myHexId = computed(() => {
    const addr = authStore.address;
    return addr ? hexEncode(addr).toLowerCase() : "";
  });

  const chatResults = computed(() => {
    const q = query.value.trim();
    if (!q) return [];
    return rankRooms(
      chatStore.sortedRooms,
      q,
      userStore.users,
      chatStore.getDisplayName,
      myHexId.value,
    );
  });

  const channelResults = computed(() => {
    const q = query.value.trim();
    if (!q) return [];
    return rankChannels(channelStore.channels, q);
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
    channelResults,
    messageResults,
    clearSearch,
  };
}
