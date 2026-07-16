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

function makeMsg(roomId: string, overrides: Partial<LocalMessage> = {}): LocalMessage {
  return {
    eventId: overrides.eventId ?? `$evt_${Math.random().toString(36).slice(2)}`,
    clientId: overrides.clientId ?? `cli_${Math.random().toString(36).slice(2)}`,
    roomId,
    senderId: "user1",
    content: "hello",
    timestamp: overrides.timestamp ?? Date.now(),
    type: MessageType.text,
    status: "synced",
    version: 1,
    softDeleted: false,
    ...overrides,
  } as LocalMessage;
}

function makeRoom(id: string, overrides: Partial<LocalRoom> = {}): LocalRoom {
  return {
    id,
    name: "Room",
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
  const name = `test-tombstone-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  db = new ChatDatabase(name);
  await db.open();
  msgRepo = new MessageRepository(db);
  roomRepo = new RoomRepository(db);
});

afterEach(async () => {
  await db.delete();
});

describe("bulkTombstoneRooms (WEE-61 / forta-bugs#892)", () => {
  it("soft-deletes rooms and PRESERVES their messages (no data loss)", async () => {
    await db.rooms.bulkAdd([makeRoom("!a:s"), makeRoom("!b:s")]);
    await db.messages.bulkAdd([makeMsg("!a:s"), makeMsg("!a:s"), makeMsg("!b:s")]);

    await roomRepo.bulkTombstoneRooms(["!a:s", "!b:s"], "removed");

    // Rooms still exist in Dexie (recoverable), just hidden.
    expect(await db.rooms.count()).toBe(2);
    // Messages are untouched — the whole point of the fix.
    expect(await db.messages.count()).toBe(3);

    const a = await db.rooms.get("!a:s");
    expect(a?.isDeleted).toBe(true);
    expect(a?.deleteReason).toBe("removed");
    expect(a?.membership).toBe("leave");
    expect(typeof a?.deletedAt).toBe("number");
  });

  it("tombstoned rooms are excluded from getAllRooms but revivable", async () => {
    await db.rooms.bulkAdd([makeRoom("!a:s")]);
    await roomRepo.bulkTombstoneRooms(["!a:s"], "removed");

    expect(await roomRepo.getAllRooms()).toHaveLength(0);
    expect(await roomRepo.isTombstoned("!a:s")).toBe(true);

    await roomRepo.reviveRoom("!a:s");
    expect(await roomRepo.isTombstoned("!a:s")).toBe(false);
  });

  it("is a no-op for an empty id list", async () => {
    await db.rooms.bulkAdd([makeRoom("!a:s")]);
    await roomRepo.bulkTombstoneRooms([], "removed");

    expect(await roomRepo.isTombstoned("!a:s")).toBe(false);
  });
});
