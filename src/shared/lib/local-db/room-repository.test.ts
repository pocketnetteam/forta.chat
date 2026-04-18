import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Dexie from "dexie";
import "fake-indexeddb/auto";
import { RoomRepository } from "./room-repository";
import type { LocalRoom } from "./schema";

// ── Minimal in-memory Dexie database for tests ──────────────────────
class TestDb extends Dexie {
  rooms!: import("dexie").Table<LocalRoom, string>;
  constructor() {
    super("test-room-repo", { indexedDB, IDBKeyRange });
    this.version(1).stores({
      rooms: "id, membership, updatedAt, isDeleted",
    });
  }
}

// ── Helper to create test rooms ─────────────────────────────────────
function makeLocalRoom(overrides: Partial<LocalRoom> = {}): LocalRoom {
  return {
    id: overrides.id ?? `!room_${Math.random().toString(36).slice(2)}:s`,
    name: "Test Room",
    isGroup: false,
    members: ["user1"],
    membership: "join",
    unreadCount: 0,
    updatedAt: Date.now(),
    hasMoreHistory: true,
    lastReadInboundTs: 0,
    lastReadOutboundTs: 0,
    isDeleted: false,
    deletedAt: null,
    deleteReason: null,
    syncedAt: Date.now(),
    ...overrides,
  } as LocalRoom;
}

// ── Tests ────────────────────────────────────────────────────────────
describe("RoomRepository", () => {
  let db: TestDb;
  let repo: RoomRepository;

  beforeEach(() => {
    db = new TestDb();
    // Cast to ChatDatabase — the test DB implements the subset we need
    repo = new RoomRepository(db as any);
  });

  afterEach(async () => {
    await db.delete();
  });

  // ── bulkSyncRooms ───────────────────────────────────────────────

  describe("bulkSyncRooms", () => {
    it("inserts new rooms in a single transaction", async () => {
      await repo.bulkSyncRooms([
        { id: "!a:s", name: "Room A", membership: "join" },
        { id: "!b:s", name: "Room B", membership: "join" },
        { id: "!c:s", name: "Room C", membership: "join" },
      ]);

      const rooms = await repo.getAllRooms();
      expect(rooms).toHaveLength(3);
      expect(rooms.map((r) => r.id).sort()).toEqual(["!a:s", "!b:s", "!c:s"]);
    });

    it("updates existing rooms without overwriting preview fields", async () => {
      // Pre-populate with preview data
      const existing = makeLocalRoom({
        id: "!existing:s",
        name: "Old Name",
        lastMessagePreview: "Hello there!",
        lastMessageTimestamp: 3000,
        lastMessageSenderId: "sender1",
        unreadCount: 5,
        lastReadInboundTs: 2000,
        lastReadOutboundTs: 1000,
      });
      await db.rooms.put(existing);

      // Sync with metadata-only update
      await repo.bulkSyncRooms([
        { id: "!existing:s", name: "New Name", avatar: "mxc://avatar" },
      ]);

      const room = await repo.getRoom("!existing:s");
      expect(room).toBeDefined();
      // Metadata updated
      expect(room!.name).toBe("New Name");
      expect(room!.avatar).toBe("mxc://avatar");
      // Preview/unread/watermark fields preserved
      expect(room!.lastMessagePreview).toBe("Hello there!");
      expect(room!.lastMessageTimestamp).toBe(3000);
      expect(room!.lastMessageSenderId).toBe("sender1");
      expect(room!.unreadCount).toBe(5);
      expect(room!.lastReadInboundTs).toBe(2000);
      expect(room!.lastReadOutboundTs).toBe(1000);
    });

    it("revives tombstoned rooms", async () => {
      // Pre-populate tombstoned room
      const tombstoned = makeLocalRoom({
        id: "!tombstoned:s",
        name: "Dead Room",
        isDeleted: true,
        deletedAt: Date.now() - 10000,
        deleteReason: "left",
        membership: "leave",
      });
      await db.rooms.put(tombstoned);

      // Sync — should revive
      await repo.bulkSyncRooms([
        { id: "!tombstoned:s", name: "Alive Again", membership: "join" },
      ]);

      const room = await repo.getRoom("!tombstoned:s");
      expect(room).toBeDefined();
      expect(room!.isDeleted).toBe(false);
      expect(room!.deletedAt).toBeNull();
      expect(room!.deleteReason).toBeNull();
      expect(room!.name).toBe("Alive Again");
      expect(room!.membership).toBe("join");
    });

    it("monotonically advances updatedAt and lastMessageTimestamp", async () => {
      const existing = makeLocalRoom({
        id: "!mono:s",
        updatedAt: 5000,
        lastMessageTimestamp: 4000,
      });
      await db.rooms.put(existing);

      // Try to sync with older timestamps
      await repo.bulkSyncRooms([
        { id: "!mono:s", updatedAt: 3000, lastMessageTimestamp: 2000 },
      ]);

      const room = await repo.getRoom("!mono:s");
      expect(room).toBeDefined();
      // Originals preserved (newer wins)
      expect(room!.updatedAt).toBe(5000);
      expect(room!.lastMessageTimestamp).toBe(4000);

      // Now sync with newer timestamps — should advance
      await repo.bulkSyncRooms([
        { id: "!mono:s", updatedAt: 9000, lastMessageTimestamp: 8000 },
      ]);

      const updated = await repo.getRoom("!mono:s");
      expect(updated!.updatedAt).toBe(9000);
      expect(updated!.lastMessageTimestamp).toBe(8000);
    });

    it("chunked calls produce same result as single call", async () => {
      const updates = Array.from({ length: 150 }, (_, i) => ({
        id: `!r${i}:s`,
        name: `Room ${i}`,
        membership: "join" as const,
        lastMessageTimestamp: 1000 + i,
      }));

      const CHUNK = 100;
      for (let i = 0; i < updates.length; i += CHUNK) {
        await repo.bulkSyncRooms(updates.slice(i, i + CHUNK));
      }

      const rooms = await repo.getAllRooms();
      expect(rooms).toHaveLength(150);
      // getAllRooms returns UNSORTED — just verify all rooms are present
      const ids = new Set(rooms.map((r) => r.id));
      expect(ids.has("!r0:s")).toBe(true);
      expect(ids.has("!r149:s")).toBe(true);
    });

    it("chunked updates correctly patch existing rooms", async () => {
      await repo.bulkSyncRooms([
        { id: "!a:s", name: "Room A", membership: "join", lastMessageTimestamp: 1000 },
        { id: "!b:s", name: "Room B", membership: "join", lastMessageTimestamp: 2000 },
      ]);

      await repo.updateLastMessage("!a:s", "Hello!", 1000, "sender1");

      await repo.bulkSyncRooms([
        { id: "!a:s", name: "Updated A", membership: "join", lastMessageTimestamp: 1000 },
      ]);
      await repo.bulkSyncRooms([
        { id: "!b:s", name: "Updated B", membership: "join", lastMessageTimestamp: 2000 },
      ]);

      const a = await repo.getRoom("!a:s");
      expect(a!.name).toBe("Updated A");
      expect(a!.lastMessagePreview).toBe("Hello!");

      const b = await repo.getRoom("!b:s");
      expect(b!.name).toBe("Updated B");
    });
  });

  // ── getAllRooms (unsorted) ────────────────────────────────────────

  describe("getAllRooms", () => {
    it("returns joined and invited rooms (unsorted)", async () => {
      await db.rooms.bulkPut([
        makeLocalRoom({ id: "!old:s", lastMessageTimestamp: 1000, membership: "join" }),
        makeLocalRoom({ id: "!new:s", lastMessageTimestamp: 3000, membership: "join" }),
        makeLocalRoom({ id: "!mid:s", lastMessageTimestamp: 2000, membership: "join" }),
      ]);

      const rooms = await repo.getAllRooms();
      expect(rooms).toHaveLength(3);
      expect(rooms.map((r) => r.id).sort()).toEqual(["!mid:s", "!new:s", "!old:s"]);
    });

    it("includes invites alongside joined rooms", async () => {
      await db.rooms.bulkPut([
        makeLocalRoom({ id: "!invite:s", lastMessageTimestamp: 9999, membership: "invite" }),
        makeLocalRoom({ id: "!joined:s", lastMessageTimestamp: 100, membership: "join" }),
      ]);

      const rooms = await repo.getAllRooms();
      expect(rooms).toHaveLength(2);
      expect(rooms.map((r) => r.id).sort()).toEqual(["!invite:s", "!joined:s"]);
    });

    it("excludes tombstoned rooms", async () => {
      await db.rooms.bulkPut([
        makeLocalRoom({ id: "!alive:s", membership: "join" }),
        makeLocalRoom({ id: "!dead:s", membership: "join", isDeleted: true, deletedAt: Date.now(), deleteReason: "left" }),
      ]);

      const rooms = await repo.getAllRooms();
      expect(rooms).toHaveLength(1);
      expect(rooms[0].id).toBe("!alive:s");
    });
  });

  // ── markAsRead (boolean) ──────────────────────────────────────────

  describe("markAsRead", () => {
    it("returns true when watermark advances", async () => {
      await db.rooms.put(makeLocalRoom({ id: "!r:s", lastReadInboundTs: 500 }));
      const ok = await repo.markAsRead("!r:s", 1000);
      expect(ok).toBe(true);
    });

    it("returns false when timestamp is not newer than watermark", async () => {
      await db.rooms.put(makeLocalRoom({ id: "!r:s", lastReadInboundTs: 2000 }));
      const ok = await repo.markAsRead("!r:s", 1000);
      expect(ok).toBe(false);
    });

    it("returns false when room does not exist", async () => {
      const ok = await repo.markAsRead("!missing:s", 1000);
      expect(ok).toBe(false);
    });
  });
});
