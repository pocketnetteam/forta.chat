import { describe, it, expect, beforeEach, afterEach } from "vitest";
import "fake-indexeddb/auto";
import { ChatDatabase } from "../schema";
import type { LocalMessage, LocalRoom } from "../schema";
import { MessageRepository } from "../message-repository";
import { RoomRepository } from "../room-repository";
import { MessageType } from "@/entities/chat/model/types";

let db: ChatDatabase;
let msgRepo: MessageRepository;
let roomRepo: RoomRepository;

const ROOM_ID = "!room:server";

function makeMsg(overrides: Partial<LocalMessage> = {}): LocalMessage {
  return {
    eventId: overrides.eventId ?? `$evt_${Math.random().toString(36).slice(2)}`,
    clientId: overrides.clientId ?? `cli_${Math.random().toString(36).slice(2)}`,
    roomId: overrides.roomId ?? ROOM_ID,
    senderId: overrides.senderId ?? "user1",
    content: overrides.content ?? "hello",
    timestamp: overrides.timestamp ?? Date.now(),
    type: overrides.type ?? MessageType.text,
    status: overrides.status ?? "synced",
    version: 1,
    softDeleted: false,
    ...overrides,
  } as LocalMessage;
}

function makeRoom(overrides: Partial<LocalRoom> = {}): LocalRoom {
  return {
    id: overrides.id ?? ROOM_ID,
    name: "Test Room",
    isGroup: false,
    members: ["user1", "user2"],
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

beforeEach(async () => {
  const name = `test-clear-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  db = new ChatDatabase(name);
  await db.open();
  msgRepo = new MessageRepository(db);
  roomRepo = new RoomRepository(db);
});

afterEach(async () => {
  await db.delete();
});

describe("clear-history", () => {
  describe("MessageRepository write-guards", () => {
    it("upsertFromServer skips messages older than clearedAtTs", async () => {
      const msg = makeMsg({ timestamp: 1000 });
      const result = await msgRepo.upsertFromServer(msg, 2000);
      expect(result).toBe("duplicate");

      const count = await db.messages.count();
      expect(count).toBe(0);
    });

    it("upsertFromServer skips messages equal to clearedAtTs", async () => {
      const msg = makeMsg({ timestamp: 2000 });
      const result = await msgRepo.upsertFromServer(msg, 2000);
      expect(result).toBe("duplicate");

      const count = await db.messages.count();
      expect(count).toBe(0);
    });

    it("upsertFromServer allows messages newer than clearedAtTs", async () => {
      const msg = makeMsg({ timestamp: 3000 });
      const result = await msgRepo.upsertFromServer(msg, 2000);
      expect(result).toBe("inserted");

      const count = await db.messages.count();
      expect(count).toBe(1);
    });

    it("upsertFromServer works normally without clearedAtTs", async () => {
      const msg = makeMsg({ timestamp: 1000 });
      const result = await msgRepo.upsertFromServer(msg);
      expect(result).toBe("inserted");

      const count = await db.messages.count();
      expect(count).toBe(1);
    });

    it("bulkInsert filters out messages older than clearedAtTs", async () => {
      const msgs = [100, 200, 300, 400, 500].map((ts) =>
        makeMsg({ timestamp: ts }),
      );
      await msgRepo.bulkInsert(msgs, 300);

      const all = await db.messages.toArray();
      expect(all).toHaveLength(2);
      const timestamps = all.map((m) => m.timestamp).sort((a, b) => a - b);
      expect(timestamps).toEqual([400, 500]);
    });

    it("bulkInsert inserts all when clearedAtTs is undefined", async () => {
      const msgs = [100, 200, 300].map((ts) => makeMsg({ timestamp: ts }));
      await msgRepo.bulkInsert(msgs);

      const all = await db.messages.toArray();
      expect(all).toHaveLength(3);
    });
  });

  describe("purgeBeforeTimestamp", () => {
    it("deletes messages at or before timestamp", async () => {
      const msgs = [100, 200, 300, 400, 500].map((ts) =>
        makeMsg({ timestamp: ts }),
      );
      await db.messages.bulkAdd(msgs);

      const deleted = await msgRepo.purgeBeforeTimestamp(ROOM_ID, 300);

      const remaining = await db.messages.toArray();
      const timestamps = remaining
        .map((m) => m.timestamp)
        .sort((a, b) => a - b);
      // Upper bound inclusive: timestamps 100, 200, 300 deleted; 400, 500 remain
      expect(timestamps).toEqual([400, 500]);
      expect(deleted).toBe(3);
    });

    it("leaves messages in other rooms untouched", async () => {
      await db.messages.bulkAdd([
        makeMsg({ roomId: "!room-a:s", timestamp: 100 }),
        makeMsg({ roomId: "!room-a:s", timestamp: 200 }),
        makeMsg({ roomId: "!room-b:s", timestamp: 100 }),
        makeMsg({ roomId: "!room-b:s", timestamp: 200 }),
      ]);

      await msgRepo.purgeBeforeTimestamp("!room-a:s", 9999);

      const roomA = await db.messages
        .where("[roomId+timestamp]")
        .between(["!room-a:s", -Infinity], ["!room-a:s", Infinity])
        .toArray();
      const roomB = await db.messages
        .where("[roomId+timestamp]")
        .between(["!room-b:s", -Infinity], ["!room-b:s", Infinity])
        .toArray();

      expect(roomA).toHaveLength(0);
      expect(roomB).toHaveLength(2);
    });
  });

  describe("getMessages with clearedAtTs", () => {
    it("returns only messages after clearedAtTs", async () => {
      const msgs = [100, 200, 300, 400, 500].map((ts) =>
        makeMsg({ timestamp: ts }),
      );
      await db.messages.bulkAdd(msgs);

      const result = await msgRepo.getMessages(ROOM_ID, 50, undefined, 300);
      const timestamps = result.map((m) => m.timestamp);
      expect(timestamps).toEqual([400, 500]);
    });

    it("returns all messages when clearedAtTs is undefined", async () => {
      const msgs = [100, 200, 300, 400, 500].map((ts) =>
        makeMsg({ timestamp: ts }),
      );
      await db.messages.bulkAdd(msgs);

      const result = await msgRepo.getMessages(ROOM_ID, 50);
      expect(result).toHaveLength(5);
    });
  });

  describe("getLastNonDeleted with clearedAtTs", () => {
    it("ignores messages before clearedAtTs", async () => {
      const msgs = [100, 200, 300].map((ts) =>
        makeMsg({ timestamp: ts, content: `msg-${ts}` }),
      );
      await db.messages.bulkAdd(msgs);

      const last = await msgRepo.getLastNonDeleted(ROOM_ID, 200);
      expect(last).toBeDefined();
      expect(last!.timestamp).toBe(300);
      expect(last!.content).toBe("msg-300");
    });

    it("returns undefined when all messages are before clearedAtTs", async () => {
      const msgs = [100, 200].map((ts) => makeMsg({ timestamp: ts }));
      await db.messages.bulkAdd(msgs);

      const last = await msgRepo.getLastNonDeleted(ROOM_ID, 500);
      expect(last).toBeUndefined();
    });

    it("works without clearedAtTs", async () => {
      const msgs = [100, 200, 300].map((ts) => makeMsg({ timestamp: ts }));
      await db.messages.bulkAdd(msgs);

      const last = await msgRepo.getLastNonDeleted(ROOM_ID);
      expect(last).toBeDefined();
      expect(last!.timestamp).toBe(300);
    });
  });

  describe("RoomRepository.clearHistory", () => {
    it("sets clearedAtTs and resets preview fields", async () => {
      const room = makeRoom({
        lastMessagePreview: "old message",
        lastMessageTimestamp: 1000,
        lastMessageSenderId: "user1",
        lastMessageType: MessageType.text,
        lastMessageEventId: "$evt1",
        lastMessageReaction: {
          emoji: "👍",
          senderAddress: "user2",
          timestamp: 900,
        },
        lastMessageLocalStatus: "synced",
        hasMoreHistory: false,
        paginationToken: "tok_abc",
      });
      await db.rooms.put(room);

      const now = Date.now();
      await roomRepo.clearHistory(ROOM_ID, now);

      const updated = await db.rooms.get(ROOM_ID);
      expect(updated).toBeDefined();
      expect(updated!.clearedAtTs).toBe(now);
      // Dexie.update() ignores undefined values, so we use null to clear fields
      expect(updated!.lastMessagePreview).toBeNull();
      expect(updated!.lastMessageTimestamp).toBeNull();
      expect(updated!.lastMessageSenderId).toBeNull();
      expect(updated!.lastMessageType).toBeNull();
      expect(updated!.lastMessageEventId).toBeNull();
      expect(updated!.lastMessageReaction).toBeNull();
      expect(updated!.lastMessageLocalStatus).toBeNull();
      expect(updated!.hasMoreHistory).toBe(false);
      expect(updated!.paginationToken).toBeNull();
    });

    it("preserves room membership and non-preview fields", async () => {
      const room = makeRoom({
        name: "My Chat",
        membership: "join",
        members: ["user1", "user2"],
        isGroup: true,
        unreadCount: 5,
        isDeleted: false,
        topic: "Test topic",
      });
      await db.rooms.put(room);

      await roomRepo.clearHistory(ROOM_ID, Date.now());

      const updated = await db.rooms.get(ROOM_ID);
      expect(updated!.name).toBe("My Chat");
      expect(updated!.membership).toBe("join");
      expect(updated!.members).toEqual(["user1", "user2"]);
      expect(updated!.isGroup).toBe(true);
      expect(updated!.isDeleted).toBe(false);
      expect(updated!.topic).toBe("Test topic");
    });
  });

  describe("bulkSyncRooms clearedAtTs guard", () => {
    it("does not restore lastMessageTimestamp when <= clearedAtTs", async () => {
      const room = makeRoom({ id: ROOM_ID });
      await db.rooms.put(room);
      await roomRepo.clearHistory(ROOM_ID, 5000);

      // Simulate fullRoomRefresh writing old timestamp via bulkSyncRooms
      await roomRepo.bulkSyncRooms([{
        id: ROOM_ID,
        lastMessageTimestamp: 4000, // before clearedAtTs
        updatedAt: 4000,
      }]);

      const updated = await db.rooms.get(ROOM_ID);
      // lastMessageTimestamp should NOT be restored to 4000
      expect(updated!.lastMessageTimestamp).not.toBe(4000);
    });

    it("allows lastMessageTimestamp when > clearedAtTs", async () => {
      const room = makeRoom({ id: ROOM_ID });
      await db.rooms.put(room);
      await roomRepo.clearHistory(ROOM_ID, 5000);

      await roomRepo.bulkSyncRooms([{
        id: ROOM_ID,
        lastMessageTimestamp: 6000, // after clearedAtTs
        updatedAt: 6000,
      }]);

      const updated = await db.rooms.get(ROOM_ID);
      expect(updated!.lastMessageTimestamp).toBe(6000);
    });
  });

  describe("RoomRepository.getClearedAtTs", () => {
    it("returns undefined when no clear-history marker set", async () => {
      await db.rooms.put(makeRoom());
      const ts = await roomRepo.getClearedAtTs(ROOM_ID);
      expect(ts).toBeUndefined();
    });

    it("returns the clearedAtTs after clearHistory", async () => {
      await db.rooms.put(makeRoom());
      const now = Date.now();
      await roomRepo.clearHistory(ROOM_ID, now);

      const ts = await roomRepo.getClearedAtTs(ROOM_ID);
      expect(ts).toBe(now);
    });
  });
});
