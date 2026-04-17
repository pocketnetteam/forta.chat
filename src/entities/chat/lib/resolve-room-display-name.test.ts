import { describe, it, expect } from "vitest";
import { hexEncode } from "@/shared/lib/matrix/functions";
import { resolveRoomDisplayName } from "./resolve-room-display-name";
import type { ChatRoom } from "../model/types";

const OTHER_RAW = "PPbNqCweFnTePQyXWR21B9jXWCiDJa2yYu";
const OTHER_HEX = hexEncode(OTHER_RAW).toLowerCase();

const baseRoom: Pick<ChatRoom, "id" | "unreadCount" | "updatedAt" | "members"> = {
  id: "!test:example.org",
  unreadCount: 0,
  updatedAt: 1,
  members: [],
};

describe("resolveRoomDisplayName", () => {
  it("1:1 with no member names falls back to cleanMatrixIds(room.name) (chat list parity)", () => {
    const room: ChatRoom = {
      ...baseRoom,
      name: "Display From Room State",
      isGroup: false,
      members: [OTHER_HEX],
    };
    const out = resolveRoomDisplayName(room, {}, "", () => "");
    expect(out).toBe("Display From Room State");
  });

  it("prefers Pocketnet profile name over room.name for 1:1", () => {
    const room: ChatRoom = {
      ...baseRoom,
      name: "ignored",
      isGroup: false,
      members: [OTHER_HEX],
    };
    const out = resolveRoomDisplayName(
      room,
      { [OTHER_RAW]: { name: "Alice" } },
      "",
      () => "",
    );
    expect(out).toBe("Alice");
  });
});
