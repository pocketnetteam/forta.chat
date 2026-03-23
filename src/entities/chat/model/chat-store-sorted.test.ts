import { describe, it, expect, beforeEach } from "vitest";
import { setActivePinia } from "pinia";
import { createTestingPinia } from "@pinia/testing";
import { useChatStore } from "./chat-store";
import { makeRoom } from "@/test-utils";
import type { Message } from "./types";
import { MessageStatus, MessageType } from "./types";

function makeMsgField(overrides: Partial<Message> = {}): Message {
  return {
    id: "m1",
    roomId: "!r:s",
    senderId: "u",
    content: "text",
    timestamp: 0,
    status: MessageStatus.sent,
    type: MessageType.text,
    ...overrides,
  };
}

describe("sortedRooms", () => {
  let store: ReturnType<typeof useChatStore>;

  beforeEach(() => {
    setActivePinia(createTestingPinia({ stubActions: false }));
    store = useChatStore();
  });

  it("sorts pinned rooms first", () => {
    const r1 = makeRoom({ id: "!a:s", lastMessage: makeMsgField({ timestamp: 100 }) });
    const r2 = makeRoom({ id: "!b:s", lastMessage: makeMsgField({ timestamp: 200 }) });
    store.rooms = [r1, r2];
    store.togglePinRoom("!a:s");
    const sorted = store.sortedRooms;
    expect(sorted[0].id).toBe("!a:s");
    expect(sorted[1].id).toBe("!b:s");
  });

  it("sorts joined rooms above invites regardless of timestamp", () => {
    const joined = makeRoom({ id: "!j:s", membership: "join", lastMessage: makeMsgField({ timestamp: 100 }) });
    const invite = makeRoom({ id: "!i:s", membership: "invite", lastMessage: makeMsgField({ timestamp: 9999 }) });
    store.rooms = [invite, joined];
    const sorted = store.sortedRooms;
    expect(sorted[0].id).toBe("!j:s");
    expect(sorted[1].id).toBe("!i:s");
  });

  it("sorts by timestamp within same tier (newest first)", () => {
    const old = makeRoom({ id: "!old:s", lastMessage: makeMsgField({ timestamp: 100 }) });
    const mid = makeRoom({ id: "!mid:s", lastMessage: makeMsgField({ timestamp: 200 }) });
    const fresh = makeRoom({ id: "!new:s", lastMessage: makeMsgField({ timestamp: 300 }) });
    store.rooms = [old, fresh, mid];
    const sorted = store.sortedRooms;
    expect(sorted.map(r => r.id)).toEqual(["!new:s", "!mid:s", "!old:s"]);
  });

  it("returns rooms without lastMessage at the bottom", () => {
    const withMsg = makeRoom({ id: "!a:s", lastMessage: makeMsgField({ timestamp: 100 }) });
    const noMsg = makeRoom({ id: "!b:s" });
    store.rooms = [noMsg, withMsg];
    const sorted = store.sortedRooms;
    expect(sorted[0].id).toBe("!a:s");
    expect(sorted[1].id).toBe("!b:s");
  });
});
