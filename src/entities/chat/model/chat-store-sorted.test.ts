import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
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

  describe("empty list guard", () => {
    let guardStore: ReturnType<typeof useChatStore>;

    beforeEach(() => {
      setActivePinia(createTestingPinia({ stubActions: false }));
      guardStore = useChatStore();
    });

    it("uses in-memory rooms when dexieRooms would be empty", () => {
      // Simulate: cached rooms loaded into rooms.value
      guardStore.rooms = [
        makeRoom({ id: "!a:s", lastMessage: makeMsgField({ timestamp: 200 }) }),
        makeRoom({ id: "!b:s", lastMessage: makeMsgField({ timestamp: 100 }) }),
      ];
      expect(guardStore.sortedRooms).toHaveLength(2);
      expect(guardStore.sortedRooms[0].id).toBe("!a:s");

      // Replace with different rooms — should still work via fallback
      guardStore.rooms = [
        makeRoom({ id: "!c:s", lastMessage: makeMsgField({ timestamp: 300 }) }),
      ];
      expect(guardStore.sortedRooms).toHaveLength(1);
      expect(guardStore.sortedRooms[0].id).toBe("!c:s");
    });
  });

  it("recomputes synchronously on rooms fallback changes (no throttle)", () => {
    // Verify that rooms (fallback path) changes are always reflected immediately
    store.rooms = [makeRoom({ id: "!a:s", lastMessage: makeMsgField({ timestamp: 100 }) })];
    expect(store.sortedRooms).toHaveLength(1);
    expect(store.sortedRooms[0].id).toBe("!a:s");

    // Rapid second update — should be reflected immediately (no throttle on fallback path)
    store.rooms = [
      makeRoom({ id: "!x:s", lastMessage: makeMsgField({ timestamp: 100 }) }),
      makeRoom({ id: "!y:s", lastMessage: makeMsgField({ timestamp: 300 }) }),
    ];
    expect(store.sortedRooms).toHaveLength(2);
    // !y:s (timestamp 300) sorts before !x:s (timestamp 100)
    expect(store.sortedRooms.map(r => r.id)).toEqual(["!y:s", "!x:s"]);
  });
});

describe("large room list", () => {
  let store: ReturnType<typeof useChatStore>;

  beforeEach(() => {
    setActivePinia(createTestingPinia({ stubActions: false }));
    store = useChatStore();
  });

  it("correctly sorts 500 rooms by timestamp", () => {
    const rooms = Array.from({ length: 500 }, (_, i) =>
      makeRoom({
        id: `!r${i}:s`,
        lastMessage: makeMsgField({ timestamp: Math.floor(Math.random() * 100000) }),
      })
    );
    store.rooms = rooms;
    const sorted = store.sortedRooms;
    expect(sorted).toHaveLength(500);
    for (let i = 1; i < sorted.length; i++) {
      const prevTs = sorted[i - 1].lastMessage?.timestamp ?? 0;
      const currTs = sorted[i].lastMessage?.timestamp ?? 0;
      expect(prevTs).toBeGreaterThanOrEqual(currTs);
    }
  });

  it("pinned rooms stay at top with 500 rooms", () => {
    const rooms = Array.from({ length: 500 }, (_, i) =>
      makeRoom({
        id: `!r${i}:s`,
        lastMessage: makeMsgField({ timestamp: 1000 + i }),
      })
    );
    store.rooms = rooms;
    store.togglePinRoom("!r0:s");
    const sorted = store.sortedRooms;
    expect(sorted[0].id).toBe("!r0:s");
  });
});
