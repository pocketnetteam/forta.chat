import { describe, it, expect } from "vitest";
import { getRoomForUiSync } from "./room-for-ui-sync";
import type { ChatRoom } from "../model/types";

const mk = (id: string): ChatRoom => ({
  id,
  name: id,
  unreadCount: 0,
  members: [],
  isGroup: false,
  updatedAt: 1,
});

describe("getRoomForUiSync", () => {
  it("prefers activeRoom when it matches activeRoomId", () => {
    const a = mk("!a:s");
    const b = mk("!b:s");
    const store = {
      activeRoomId: "!a:s" as string | null,
      activeRoom: a,
      sortedRooms: [b, a],
    };
    expect(getRoomForUiSync(store)).toBe(a);
  });

  it("falls back to sortedRooms when activeRoom is missing or wrong id", () => {
    const a = mk("!a:s");
    const store = {
      activeRoomId: "!a:s" as string | null,
      activeRoom: undefined as ChatRoom | undefined,
      sortedRooms: [mk("!z:s"), a],
    };
    expect(getRoomForUiSync(store)).toBe(a);
  });
});
