import { describe, it, expect } from "vitest";
import { rankChatRoomsBySearchRelevance } from "./rank-chat-rooms";
import type { ChatRoom } from "@/entities/chat";

function makeRoom(partial: Partial<ChatRoom> & { id: string }): ChatRoom {
  const { id, ...rest } = partial;
  return {
    id,
    name: "Room",
    members: [],
    isGroup: false,
    unreadCount: 0,
    membership: "join",
    updatedAt: Date.now(),
    ...rest,
  } as ChatRoom;
}

describe("rankChatRoomsBySearchRelevance", () => {
  it("ranks by point = queryLen / haystackLen when haystack includes query", () => {
    const rooms = [
      makeRoom({ id: "!a:s", name: "AliceChat", members: ["aaa"], updatedAt: 1 }),
      makeRoom({ id: "!b:s", name: "BobVeryLongChatNameHere", members: ["bbb"], updatedAt: 2 }),
    ];
    const ctx = {
      queryLower: "chat",
      getMatrixRoom: () => null,
      getMemberNameLower: (addr: string) => (addr === "aaa" ? "alice" : "bob"),
    };
    const out = rankChatRoomsBySearchRelevance(rooms, ctx);
    // "!a:s" haystack: alicechat + alice — shorter total → higher point
    expect(out[0]?.id).toBe("!a:s");
    expect(out.map(r => r.id)).toEqual(["!a:s", "!b:s"]);
  });

  it("uses m.room.name for public rooms when provided", () => {
    const rooms = [makeRoom({ id: "!p:s", name: "#hashname", isGroup: true, members: [] })];
    const ctx = {
      queryLower: "display",
      getMatrixRoom: () => ({
        getJoinRule: () => "public",
        currentState: {
          getStateEvents: (type: string) => {
            if (type === "m.room.name") {
              return { getContent: () => ({ name: "DisplayNamePublic" }) };
            }
            return undefined;
          },
        },
        name: "#ignored",
      }),
      getMemberNameLower: () => "",
    };
    const out = rankChatRoomsBySearchRelevance(rooms, ctx);
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe("!p:s");
  });

  it("returns empty when no match", () => {
    const rooms = [makeRoom({ id: "!x:s", name: "zzz", members: [] })];
    const out = rankChatRoomsBySearchRelevance(rooms, {
      queryLower: "nomatch",
      getMatrixRoom: () => null,
      getMemberNameLower: () => "",
    });
    expect(out).toEqual([]);
  });
});
