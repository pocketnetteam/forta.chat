import { describe, it, expect, beforeEach, afterEach } from "vitest";
import "fake-indexeddb/auto";
import { ChatDatabase } from "@/shared/lib/local-db/schema";
import type { LocalMessage, LocalRoom } from "@/shared/lib/local-db/schema";
import { MessageRepository } from "@/shared/lib/local-db/message-repository";
import { RoomRepository } from "@/shared/lib/local-db/room-repository";
import { MessageType } from "@/entities/chat/model/types";

/**
 * WEE-80 (forta-bugs#956) — local-first offline read.
 *
 * Invariant: chat history (rooms + messages) is read from Dexie via the
 * repositories, with NO dependency on the Matrix client or network. A
 * cold-start in airplane mode must surface whatever IndexedDB already holds.
 * These tests touch the repositories directly — the same code paths the
 * reactive `useLiveQuery` reads feed from — so they fail if a future change
 * reintroduces a network/Matrix gate on the read path.
 */

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
  const name = `test-offline-read-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  db = new ChatDatabase(name);
  await db.open();
  msgRepo = new MessageRepository(db);
  roomRepo = new RoomRepository(db);
});

afterEach(async () => {
  await db.delete();
});

describe("WEE-80 — offline read from Dexie (no Matrix, no network)", () => {
  it("A1: getAllRooms returns cached joined + invited rooms with no client started", async () => {
    // Seed as if a prior online session persisted these, then went offline.
    await roomRepo.bulkUpsertRooms([
      makeRoom("!joined:s", { name: "Alice", membership: "join" }),
      makeRoom("!invited:s", { name: "Bob", membership: "invite" }),
    ]);

    // No Matrix client, no connectivity — pure IndexedDB read.
    const rooms = await roomRepo.getAllRooms();

    const ids = rooms.map((r) => r.id).sort();
    expect(ids).toEqual(["!invited:s", "!joined:s"]);
  });

  it("A1: getMessages returns the cached conversation offline, in timeline order", async () => {
    const roomId = "!room:s";
    await roomRepo.bulkUpsertRooms([makeRoom(roomId)]);
    await db.messages.bulkAdd([
      makeMsg(roomId, { eventId: "$m1", timestamp: 1000, content: "first" }),
      makeMsg(roomId, { eventId: "$m2", timestamp: 2000, content: "second" }),
      makeMsg(roomId, { eventId: "$m3", timestamp: 3000, content: "third" }),
    ]);

    const msgs = await msgRepo.getMessages(roomId);

    expect(msgs.map((m) => m.content)).toEqual(["first", "second", "third"]);
  });

  it("A1: messages for the active room are readable while another room exists too", async () => {
    await roomRepo.bulkUpsertRooms([makeRoom("!a:s"), makeRoom("!b:s")]);
    await db.messages.bulkAdd([
      makeMsg("!a:s", { timestamp: 10, content: "a-only" }),
      makeMsg("!b:s", { timestamp: 20, content: "b-only" }),
    ]);

    const a = await msgRepo.getMessages("!a:s");
    const b = await msgRepo.getMessages("!b:s");

    expect(a.map((m) => m.content)).toEqual(["a-only"]);
    expect(b.map((m) => m.content)).toEqual(["b-only"]);
  });

  it("A3: getAllRooms hides tombstoned rooms but keeps valid ones (cleanup never wipes the live read)", async () => {
    await roomRepo.bulkUpsertRooms([
      makeRoom("!valid:s", { name: "Keep me" }),
      makeRoom("!removed:s", {
        name: "Tombstoned",
        isDeleted: true,
        deletedAt: Date.now(),
        deleteReason: "removed",
      }),
    ]);

    const rooms = await roomRepo.getAllRooms();

    expect(rooms.map((r) => r.id)).toEqual(["!valid:s"]);
  });
});
