import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { setActivePinia } from "pinia";
import { createTestingPinia } from "@pinia/testing";
import { makeRoom } from "@/test-utils";

// ── Mock MatrixClientService (real module can wire Dexie + leave sortedRooms on Dexie path) ──
const mockGetRoom = vi.fn(() => ({ selfMembership: "join" }));
const mockGetUserIdFn = vi.fn(() => "@me:server");
const mockMatrixService = {
  getUserId: mockGetUserIdFn,
  getRoom: mockGetRoom,
  sendReadReceipt: vi.fn(async () => true),
  kit: {
    client: { getUserId: mockGetUserIdFn },
    isTetatetChat: vi.fn(() => true),
    getRoomMembers: vi.fn(() => []),
  },
};

vi.mock("@/entities/matrix", () => ({
  getMatrixClientService: vi.fn(() => mockMatrixService),
}));

import { useChatStore } from "./chat-store";
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
    localStorage.clear();
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

  it("sorts invites alongside joined rooms by timestamp", () => {
    const joined = makeRoom({ id: "!j:s", membership: "join", lastMessage: makeMsgField({ timestamp: 100 }) });
    const invite = makeRoom({ id: "!i:s", membership: "invite", lastMessage: makeMsgField({ timestamp: 9999 }) });
    store.rooms = [invite, joined];
    const sorted = store.sortedRooms;
    expect(sorted[0].id).toBe("!i:s"); // newer timestamp wins, regardless of membership
    expect(sorted[1].id).toBe("!j:s");
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
    const withMsg = makeRoom({ id: "!a:s", lastMessage: makeMsgField({ timestamp: 100 }), updatedAt: 100 });
    const noMsg = makeRoom({ id: "!b:s", updatedAt: 50 });
    store.rooms = [noMsg, withMsg];
    const sorted = store.sortedRooms;
    expect(sorted[0].id).toBe("!a:s");
    expect(sorted[1].id).toBe("!b:s");
  });

  describe("empty list guard", () => {
    let guardStore: ReturnType<typeof useChatStore>;

    beforeEach(() => {
      localStorage.clear();
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

  it("recompute after single room change preserves other room references", () => {
    const r1 = makeRoom({ id: "!a:s", lastMessage: makeMsgField({ timestamp: 200 }) });
    const r2 = makeRoom({ id: "!b:s", lastMessage: makeMsgField({ timestamp: 100 }) });
    store.rooms = [r1, r2];
    const first = store.sortedRooms;
    expect(first).toHaveLength(2);

    store.rooms = [
      makeRoom({ id: "!a:s", lastMessage: makeMsgField({ timestamp: 300 }) }),
      r2,
    ];
    const second = store.sortedRooms;
    expect(second).toHaveLength(2);
    expect(second[0].id).toBe("!a:s");
    expect(second[0].lastMessage!.timestamp).toBe(300);
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

describe("invite room sorting with updatedAt fallback", () => {
  let store: ReturnType<typeof useChatStore>;

  beforeEach(() => {
    setActivePinia(createTestingPinia({ stubActions: false }));
    store = useChatStore();
  });

  it("sorts invite without lastMessage by updatedAt (not at bottom)", () => {
    // Invite with no timeline events but a valid updatedAt (invite origin_server_ts)
    const inviteNew = makeRoom({ id: "!inv1:s", membership: "invite", updatedAt: 5000 });
    const inviteOld = makeRoom({ id: "!inv2:s", membership: "invite", updatedAt: 1000 });
    store.rooms = [inviteOld, inviteNew];
    const sorted = store.sortedRooms;
    expect(sorted[0].id).toBe("!inv1:s"); // newer updatedAt first
    expect(sorted[1].id).toBe("!inv2:s");
  });

  it("sorts invite with lastMessage by message timestamp (not updatedAt)", () => {
    // Invite in active channel — has message history
    const inviteWithMsg = makeRoom({
      id: "!inv1:s",
      membership: "invite",
      updatedAt: 1000,
      lastMessage: makeMsgField({ timestamp: 5000 }),
    });
    const inviteWithOlderMsg = makeRoom({
      id: "!inv2:s",
      membership: "invite",
      updatedAt: 9000, // higher updatedAt but older message
      lastMessage: makeMsgField({ timestamp: 2000 }),
    });
    store.rooms = [inviteWithOlderMsg, inviteWithMsg];
    const sorted = store.sortedRooms;
    expect(sorted[0].id).toBe("!inv1:s"); // sorted by message timestamp, not updatedAt
  });

  it("invite without any date (updatedAt=0, no lastMessage) goes to bottom", () => {
    const inviteWithDate = makeRoom({ id: "!inv1:s", membership: "invite", updatedAt: 5000 });
    const inviteNoDate = makeRoom({ id: "!inv2:s", membership: "invite", updatedAt: 0 });
    store.rooms = [inviteNoDate, inviteWithDate];
    const sorted = store.sortedRooms;
    expect(sorted[0].id).toBe("!inv1:s");
    expect(sorted[1].id).toBe("!inv2:s"); // no date → bottom
  });

  it("invite with newer updatedAt sorts above joined room with older updatedAt", () => {
    const joined = makeRoom({ id: "!j:s", membership: "join", updatedAt: 100 });
    const invite = makeRoom({ id: "!i:s", membership: "invite", updatedAt: 99999 });
    store.rooms = [invite, joined];
    const sorted = store.sortedRooms;
    expect(sorted[0].id).toBe("!i:s"); // newer date wins, membership doesn't matter
    expect(sorted[1].id).toBe("!j:s");
  });

  it("mixed invites: some with messages, some with only updatedAt", () => {
    const invMsg = makeRoom({
      id: "!inv1:s",
      membership: "invite",
      updatedAt: 1000,
      lastMessage: makeMsgField({ timestamp: 8000 }),
    });
    const invDate = makeRoom({ id: "!inv2:s", membership: "invite", updatedAt: 5000 });
    const invEmpty = makeRoom({ id: "!inv3:s", membership: "invite", updatedAt: 0 });
    store.rooms = [invEmpty, invDate, invMsg];
    const sorted = store.sortedRooms;
    expect(sorted.map(r => r.id)).toEqual(["!inv1:s", "!inv2:s", "!inv3:s"]);
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
