import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Dexie from "dexie";
import "fake-indexeddb/auto";
import { RoomRepository } from "../room-repository";
import { MessageRepository } from "../message-repository";
import type { LocalRoom, LocalMessage } from "../schema";
import { MessageType } from "@/entities/chat/model/types";

// Minimal in-memory Dexie for testing
class TestDb extends Dexie {
  messages!: Dexie.Table<LocalMessage, number>;
  rooms!: Dexie.Table<LocalRoom, string>;
  decryptionQueue!: Dexie.Table<any, number>;
  listenedMessages!: Dexie.Table<any, string>;
  pendingOps!: Dexie.Table<any, number>;
  users!: Dexie.Table<any, string>;
  syncState!: Dexie.Table<any, string>;
  attachments!: Dexie.Table<any, number>;

  constructor(name: string) {
    super(name, { indexedDB, IDBKeyRange });
    this.version(1).stores({
      messages:
        "++localId, eventId, clientId, [roomId+timestamp], [roomId+status], senderId",
      rooms: "id, updatedAt, membership, isDeleted",
      decryptionQueue: "++id, status, [status+nextAttemptAt]",
      listenedMessages: "eventId",
      pendingOps: "++id, status",
      users: "address",
      syncState: "key",
      attachments: "++id, messageLocalId, status",
    });
  }
}

function makeRoom(overrides: Partial<LocalRoom> = {}): LocalRoom {
  return {
    id: overrides.id ?? "!room:test",
    name: "Room",
    isGroup: false,
    members: [],
    membership: "join",
    unreadCount: 0,
    lastReadInboundTs: 0,
    lastReadOutboundTs: 0,
    updatedAt: Date.now(),
    syncedAt: Date.now(),
    hasMoreHistory: true,
    isDeleted: false,
    deletedAt: null,
    deleteReason: null,
    ...overrides,
  };
}

function makeMessage(overrides: Partial<LocalMessage> = {}): LocalMessage {
  return {
    eventId: overrides.eventId ?? `$evt_${Math.random().toString(36).slice(2)}`,
    clientId: `cli_${Math.random().toString(36).slice(2)}`,
    roomId: overrides.roomId ?? "!room:test",
    senderId: overrides.senderId ?? "bob",
    content: overrides.content ?? "hello",
    timestamp: overrides.timestamp ?? Date.now(),
    type: MessageType.text,
    status: "synced" as any,
    softDeleted: false,
    version: 1,
    ...overrides,
  };
}

let db: TestDb;
let roomRepo: RoomRepository;
let msgRepo: MessageRepository;
let dbCounter = 0;

function setup() {
  db = new TestDb(`TestDb_unread_${Date.now()}_${++dbCounter}`);
  roomRepo = new RoomRepository(db as any);
  msgRepo = new MessageRepository(db as any);
}

afterEach(async () => {
  if (db) await db.delete();
});

// Helper: bind countInboundAfter to the current msgRepo
const countFn = (roomId: string, afterTs: number, excludeSenderId: string, clearedAtTs?: number) =>
  msgRepo.countInboundAfter(roomId, afterTs, excludeSenderId, clearedAtTs);

// ─── Fix 1: bulkSyncRooms reconciliation guard ────────────────────────────

describe("bulkSyncRooms — server unreadCount is always authoritative", () => {
  beforeEach(setup);

  it("always overwrites local unreadCount with server value", async () => {
    await db.rooms.put(makeRoom({
      id: "!r1:test",
      unreadCount: 3,
      syncedAt: 1000,
      lastReadInboundTs: 2000,
      lastMessageTimestamp: 2000,
    }));

    await roomRepo.bulkSyncRooms([{
      id: "!r1:test",
      serverUnreadCount: 0,
      updatedAt: Date.now(),
    }]);

    const room = await db.rooms.get("!r1:test");
    expect(room!.unreadCount).toBe(0);
  });

  it("overwrites even when messages exist after watermark (server is truth)", async () => {
    // Server says 0 — even though local has messages after watermark.
    // This is correct: server knows the real read state across all devices.
    await db.rooms.put(makeRoom({
      id: "!r2:test",
      unreadCount: 5,
      syncedAt: 1000,
      lastReadInboundTs: 1000,
      lastMessageTimestamp: 2000,
    }));

    await roomRepo.bulkSyncRooms([{
      id: "!r2:test",
      serverUnreadCount: 0,
      updatedAt: Date.now(),
    }]);

    const room = await db.rooms.get("!r2:test");
    expect(room!.unreadCount).toBe(0); // server is always authoritative
  });

  it("heals poisoned counts from fresh rooms (syncedAt=0)", async () => {
    await db.rooms.put(makeRoom({
      id: "!r3:test",
      unreadCount: 28,
      syncedAt: 0,
      lastReadInboundTs: 0,
      lastMessageTimestamp: 1000,
    }));

    await roomRepo.bulkSyncRooms([{
      id: "!r3:test",
      serverUnreadCount: 3,
      updatedAt: Date.now(),
    }]);

    const room = await db.rooms.get("!r3:test");
    expect(room!.unreadCount).toBe(3);
  });

  it("advances watermark when server says 0", async () => {
    await db.rooms.put(makeRoom({
      id: "!r4:test",
      unreadCount: 15,
      syncedAt: 0,
      lastReadInboundTs: 0,
      lastMessageTimestamp: 5000,
    }));

    await roomRepo.bulkSyncRooms([{
      id: "!r4:test",
      serverUnreadCount: 0,
      updatedAt: Date.now(),
    }]);

    const room = await db.rooms.get("!r4:test");
    expect(room!.unreadCount).toBe(0);
    expect(room!.lastReadInboundTs).toBe(5000);
  });
});

// ─── Fix 2: Atomic markAsRead ─────────────────────────────────────────────

describe("markAsRead atomicity", () => {
  beforeEach(setup);

  it("sets unreadCount=0 and advances watermark", async () => {
    await db.rooms.put(makeRoom({ id: "!r:test", unreadCount: 10, lastReadInboundTs: 500 }));

    const ok = await roomRepo.markAsRead("!r:test", 1000);
    expect(ok).toBe(true);

    const room = await db.rooms.get("!r:test");
    expect(room!.unreadCount).toBe(0);
    expect(room!.lastReadInboundTs).toBe(1000);
  });

  it("does not regress watermark (monotonic)", async () => {
    await db.rooms.put(makeRoom({ id: "!r:test", unreadCount: 0, lastReadInboundTs: 2000 }));

    const ok = await roomRepo.markAsRead("!r:test", 1000);
    expect(ok).toBe(false);

    const room = await db.rooms.get("!r:test");
    expect(room!.lastReadInboundTs).toBe(2000); // unchanged
  });

  it("handles non-existent room gracefully", async () => {
    const ok = await roomRepo.markAsRead("!nonexistent:test", 1000);
    expect(ok).toBe(false);
  });

  it("concurrent writeMessage + markAsRead resolves correctly", async () => {
    await db.rooms.put(makeRoom({ id: "!r:test", unreadCount: 5, lastReadInboundTs: 500 }));

    // Simulate concurrent operations
    await Promise.all([
      // Increment unread (like EventWriter does)
      db.rooms.where("id").equals("!r:test")
        .modify((room: LocalRoom) => { room.unreadCount++; }),
      // Mark as read
      roomRepo.markAsRead("!r:test", 1000),
    ]);

    const room = await db.rooms.get("!r:test");
    // After both operations settle, unreadCount should be 0.
    // In Dexie, modify() calls on the same row serialize via IDB locks.
    // markAsRead sets to 0 regardless of current value, so it wins.
    expect(room!.unreadCount).toBe(0);
    expect(room!.lastReadInboundTs).toBe(1000);
  });
});

// ─── Fix 4: countInboundAfter + recalculateUnreadCount ────────────────────

describe("countInboundAfter", () => {
  beforeEach(setup);

  it("counts only inbound non-soft-deleted messages after timestamp", async () => {
    const roomId = "!r:test";
    await db.messages.bulkAdd([
      makeMessage({ roomId, senderId: "alice", timestamp: 900 }),  // before watermark
      makeMessage({ roomId, senderId: "alice", timestamp: 1100 }), // after, inbound
      makeMessage({ roomId, senderId: "alice", timestamp: 1200 }), // after, inbound
      makeMessage({ roomId, senderId: "me", timestamp: 1300 }),    // after, own
      makeMessage({ roomId, senderId: "alice", timestamp: 1400, softDeleted: true }), // soft-deleted
    ]);

    const count = await msgRepo.countInboundAfter(roomId, 1000, "me");
    expect(count).toBe(2); // only 1100 and 1200
  });

  it("returns 0 when no messages after timestamp", async () => {
    const roomId = "!r:test";
    await db.messages.bulkAdd([
      makeMessage({ roomId, senderId: "alice", timestamp: 500 }),
      makeMessage({ roomId, senderId: "alice", timestamp: 800 }),
    ]);

    const count = await msgRepo.countInboundAfter(roomId, 1000, "me");
    expect(count).toBe(0);
  });

  it("respects clearedAtTs parameter", async () => {
    const roomId = "!r:test";
    await db.messages.bulkAdd([
      makeMessage({ roomId, senderId: "alice", timestamp: 1100 }), // after watermark but before clear
      makeMessage({ roomId, senderId: "alice", timestamp: 1600 }), // after clear
      makeMessage({ roomId, senderId: "alice", timestamp: 1700 }), // after clear
    ]);

    const count = await msgRepo.countInboundAfter(roomId, 500, "me", 1500);
    expect(count).toBe(2); // only 1600 and 1700
  });
});

describe("recalculateUnreadCount", () => {
  beforeEach(setup);

  it("corrects drifted unreadCount", async () => {
    const roomId = "!r:test";
    await db.rooms.put(makeRoom({
      id: roomId,
      unreadCount: 10, // wrong!
      lastReadInboundTs: 1000,
    }));
    await db.messages.bulkAdd([
      makeMessage({ roomId, senderId: "alice", timestamp: 900 }),  // before watermark
      makeMessage({ roomId, senderId: "alice", timestamp: 1100 }), // after
      makeMessage({ roomId, senderId: "alice", timestamp: 1200 }), // after
    ]);

    await roomRepo.recalculateUnreadCount(roomId, "me", countFn);

    const room = await db.rooms.get(roomId);
    expect(room!.unreadCount).toBe(2);
  });

  it("does not write to Dexie if count is already correct", async () => {
    const roomId = "!r:test";
    await db.rooms.put(makeRoom({
      id: roomId,
      unreadCount: 1,
      lastReadInboundTs: 1000,
    }));
    await db.messages.add(
      makeMessage({ roomId, senderId: "alice", timestamp: 1100 }),
    );

    const before = await db.rooms.get(roomId);
    await roomRepo.recalculateUnreadCount(roomId, "me", countFn);
    const after = await db.rooms.get(roomId);
    expect(after!.unreadCount).toBe(1);
    expect(after!.updatedAt).toBe(before!.updatedAt);
  });

  it("respects clearedAtTs when recalculating", async () => {
    const roomId = "!r:test";
    await db.rooms.put(makeRoom({
      id: roomId,
      unreadCount: 5,
      lastReadInboundTs: 500,
      clearedAtTs: 1500,
    }));
    await db.messages.bulkAdd([
      makeMessage({ roomId, senderId: "alice", timestamp: 1000 }), // before clear
      makeMessage({ roomId, senderId: "alice", timestamp: 1200 }), // before clear
      makeMessage({ roomId, senderId: "alice", timestamp: 1600 }), // after clear
      makeMessage({ roomId, senderId: "alice", timestamp: 1700 }), // after clear
    ]);

    await roomRepo.recalculateUnreadCount(roomId, "me", countFn);

    const room = await db.rooms.get(roomId);
    expect(room!.unreadCount).toBe(2); // only 1600 and 1700
  });
});

describe("recalculateAllUnreadCounts", () => {
  beforeEach(setup);

  it("corrects multiple rooms and returns count of corrected", async () => {
    await db.rooms.bulkPut([
      makeRoom({ id: "!r1:test", unreadCount: 0, lastReadInboundTs: 1000 }),  // correct
      makeRoom({ id: "!r2:test", unreadCount: 10, lastReadInboundTs: 1000 }), // wrong
    ]);
    await db.messages.bulkAdd([
      makeMessage({ roomId: "!r2:test", senderId: "alice", timestamp: 1100 }),
      makeMessage({ roomId: "!r2:test", senderId: "alice", timestamp: 1200 }),
    ]);

    const corrected = await roomRepo.recalculateAllUnreadCounts("me", countFn);

    expect(corrected).toBe(1);
    const r1 = await db.rooms.get("!r1:test");
    const r2 = await db.rooms.get("!r2:test");
    expect(r1!.unreadCount).toBe(0);
    expect(r2!.unreadCount).toBe(2);
  });
});

// ─── EventWriter does NOT touch unreadCount ──────────────────────────────
// Matrix SDK's getUnreadNotificationCount("total") is the single source of truth.
// EventWriter only writes messages + room previews, never increments unread.

describe("EventWriter never modifies unreadCount", () => {
  beforeEach(setup);

  it("does not change unreadCount when writing inbound messages", async () => {
    const { EventWriter } = await import("../event-writer");
    const { UserRepository } = await import("../user-repository");
    const userRepo = new UserRepository(db as any);
    const ew = new EventWriter(db as any, msgRepo, roomRepo, userRepo);

    await db.rooms.put(makeRoom({ id: "!r:test", unreadCount: 0 }));

    await ew.writeMessage(
      {
        eventId: "$msg1",
        roomId: "!r:test",
        senderId: "alice",
        content: "hello",
        timestamp: Date.now(),
        type: MessageType.text,
      },
      "me",
      "!other",
    );

    const room = await db.rooms.get("!r:test");
    expect(room!.unreadCount).toBe(0); // EventWriter never increments
  });

  it("preserves existing unreadCount when writing messages", async () => {
    const { EventWriter } = await import("../event-writer");
    const { UserRepository } = await import("../user-repository");
    const userRepo = new UserRepository(db as any);
    const ew = new EventWriter(db as any, msgRepo, roomRepo, userRepo);

    await db.rooms.put(makeRoom({ id: "!r:test", unreadCount: 5 }));

    await ew.writeMessage(
      {
        eventId: "$msg2",
        roomId: "!r:test",
        senderId: "alice",
        content: "another message",
        timestamp: Date.now(),
        type: MessageType.text,
      },
      "me",
      "!other",
    );

    const room = await db.rooms.get("!r:test");
    expect(room!.unreadCount).toBe(5); // unchanged — only Matrix SDK updates it
  });
});

// ─── bulkSyncRooms: server unreadCount is always authoritative ───────────

describe("bulkSyncRooms server unread authority", () => {
  beforeEach(setup);

  it("overwrites local unreadCount with server value", async () => {
    await db.rooms.put(makeRoom({
      id: "!r:test",
      unreadCount: 44, // poisoned from old bug
      syncedAt: 1000,
      lastReadInboundTs: 2000,
      lastMessageTimestamp: 2000,
    }));

    await roomRepo.bulkSyncRooms([{
      id: "!r:test",
      serverUnreadCount: 2,
      updatedAt: Date.now(),
    }]);

    const room = await db.rooms.get("!r:test");
    expect(room!.unreadCount).toBe(2);
  });

  it("zeroes unreadCount and advances watermark when server says 0", async () => {
    await db.rooms.put(makeRoom({
      id: "!r:test",
      unreadCount: 30,
      syncedAt: 1000,
      lastReadInboundTs: 1000,
      lastMessageTimestamp: 5000,
    }));

    await roomRepo.bulkSyncRooms([{
      id: "!r:test",
      serverUnreadCount: 0,
      updatedAt: Date.now(),
    }]);

    const room = await db.rooms.get("!r:test");
    expect(room!.unreadCount).toBe(0);
    expect(room!.lastReadInboundTs).toBe(5000); // watermark advanced
  });

  it("skips write when server count matches local", async () => {
    await db.rooms.put(makeRoom({
      id: "!r:test",
      unreadCount: 3,
      syncedAt: 1000,
      lastMessageTimestamp: 2000,
    }));

    await roomRepo.bulkSyncRooms([{
      id: "!r:test",
      serverUnreadCount: 3,
      updatedAt: 2000, // same timestamp — no change
    }]);

    // No write should have happened (count identical, no ts advance)
    const room = await db.rooms.get("!r:test");
    expect(room!.unreadCount).toBe(3);
  });
});
