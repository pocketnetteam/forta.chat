import type { ChatRoom } from "@/entities/chat";

export interface RankChatRoomsContext {
  /** Lowercased search query (non-empty). */
  queryLower: string;
  /** Matrix room for join rule / m.room.name (optional). */
  getMatrixRoom: (roomId: string) => {
    getJoinRule?: () => string;
    currentState?: { getStateEvents?: (type: string, key: string) => unknown };
    name?: string;
  } | null | undefined;
  /** Lowercase display name for a member address (hex). */
  getMemberNameLower: (address: string) => string;
}

/**
 * Chat search ranking from bastyon-chat (CHAT_SORTING.md §8):
 * `point = query.length / (chatName + memberNames).length` when the haystack includes the query.
 */
export function rankChatRoomsBySearchRelevance(
  rooms: ChatRoom[],
  ctx: RankChatRoomsContext,
): ChatRoom[] {
  const q = ctx.queryLower;
  if (!q.trim()) return rooms;

  const scored = rooms
    .map(room => {
      const mChat = ctx.getMatrixRoom(room.id);
      let chatName = "";

      if (
        mChat
        && mChat.getJoinRule?.() === "public"
        && mChat.currentState?.getStateEvents?.("m.room.name", "")
      ) {
        const nameEv = mChat.currentState.getStateEvents("m.room.name", "") as
          | { getContent?: () => { name?: string }; event?: { content?: { name?: string } } }
          | undefined;
        const raw = nameEv && (typeof nameEv.getContent === "function"
          ? nameEv.getContent()?.name
          : nameEv.event?.content?.name);
        if (raw && typeof raw === "string") chatName = raw;
      }

      if (!chatName && mChat?.name) {
        chatName = mChat.name;
        if (chatName.startsWith("#")) chatName = "";
      }

      if (!chatName) chatName = room.name;

      const userNameString = room.members.reduce(
        (acc, addr) => acc + ctx.getMemberNameLower(addr),
        "",
      );

      const uString = (chatName + userNameString).toLowerCase();
      let point = 0;
      if (uString.includes(q)) {
        point = q.length / Math.max(uString.length, 1);
      }

      return { room, point };
    })
    .filter(s => s.point > 0);

  scored.sort((a, b) => b.point - a.point);
  return scored.map(s => s.room);
}
