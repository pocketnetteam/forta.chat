import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Dexie from "dexie";
import "fake-indexeddb/auto";
import { MessageRepository } from "../message-repository";
import type { LocalMessage, LocalRoom, PendingOperation } from "../schema";

/**
 * Regression coverage for WEE-85 Part B (closing the WEE-64 gap):
 * `MessageRepository.markFailed` must mirror the failed status onto the room's
 * chat-list preview (`lastMessageLocalStatus`), not only the per-message
 * status. Otherwise a failed send shows «не доставлено» in the open bubble but
 * still «отправляется» in the sidebar preview — the rassinchron the user saw.
 *
 * Guarded by the same timestamp check as RoomRepository.syncLastMessageLocalStatus:
 * only the room's CURRENT last message may rewrite the preview badge.
 */

class TestDb extends Dexie {
  messages!: Dexie.Table<LocalMessage, number>;
  rooms!: Dexie.Table<LocalRoom, string>;
  pendingOps!: Dexie.Table<PendingOperation, number>;
  attachments!: Dexie.Table<{ id?: number; localBlob?: Blob; size?: number; status?: string }, number>;
  users!: Dexie.Table<{ address: string }, string>;
  syncState!: Dexie.Table<{ key: string; value: string | number }, string>;
  decryptionQueue!: Dexie.Table<{ id?: number; status: string }, number>;
  listenedMessages!: Dexie.Table<{ messageId: string }, string>;

  constructor(name: string) {
    super(name, { indexedDB, IDBKeyRange });
    this.version(1).stores({
      messages:
        "++localId, eventId, clientId, [roomId+timestamp], [roomId+status], senderId",
      rooms: "id, updatedAt, membership, isDeleted",
      pendingOps:
        "++id, [roomId+createdAt], status, clientId, [status+nextAttemptAt]",
      attachments: "++id, messageLocalId, status",
      users: "address, updatedAt",
      syncState: "key",
      decryptionQueue: "++id, status, [status+nextAttemptAt]",
      listenedMessages: "messageId",
    });
  }
}

const ROOM_ID = "!room:server";

function seedRoom(db: TestDb): Promise<string> {
  const room: LocalRoom = {
    id: ROOM_ID,
    name: "Test Room",
    isGroup: false,
    members: ["@me:server"],
    membership: "join",
    unreadCount: 0,
    lastReadInboundTs: 0,
    lastReadOutboundTs: 0,
    updatedAt: 1,
    isDeleted: false,
    deletedAt: null,
    deleteReason: null,
    syncedAt: 0,
    hasMoreHistory: true,
  };
  return db.rooms.put(room).then(() => room.id);
}

describe("MessageRepository.markFailed — WEE-85: chat-list preview reflects failure", () => {
  let db: TestDb;
  let messages: MessageRepository;

  beforeEach(async () => {
    db = new TestDb(`mark-failed-preview-${Date.now()}-${Math.random()}`);
    messages = new MessageRepository(db as never);
    await db.open();
  });

  afterEach(async () => {
    await db.delete();
  });

  it("flips both message status and room preview to 'failed' for the last message", async () => {
    await seedRoom(db);
    const msg = await messages.createLocal({
      roomId: ROOM_ID,
      senderId: "@me:server",
      content: "boom",
    });
    // Precondition: createLocal primed the preview to "pending".
    expect((await db.rooms.get(ROOM_ID))?.lastMessageLocalStatus).toBe("pending");

    await messages.markFailed(msg.clientId);

    const message = await messages.getByClientId(msg.clientId);
    const room = await db.rooms.get(ROOM_ID);
    expect(message?.status).toBe("failed");
    expect(room?.lastMessageLocalStatus).toBe("failed");
  });

  it("does NOT overwrite the preview when the failed message is no longer the last", async () => {
    await seedRoom(db);
    const stale = await messages.createLocal({
      roomId: ROOM_ID,
      senderId: "@me:server",
      content: "stale",
    });
    // A newer message advanced the preview to a later timestamp + synced status.
    await db.rooms.update(ROOM_ID, {
      lastMessageTimestamp: stale.timestamp + 10_000,
      lastMessageLocalStatus: "synced",
    });

    await messages.markFailed(stale.clientId);

    const message = await messages.getByClientId(stale.clientId);
    const room = await db.rooms.get(ROOM_ID);
    expect(message?.status).toBe("failed"); // per-message status still flips
    expect(room?.lastMessageLocalStatus).toBe("synced"); // preview untouched
  });

  it("is a no-op (no throw) for an unknown clientId", async () => {
    await seedRoom(db);
    await expect(messages.markFailed("does-not-exist")).resolves.toBeUndefined();
  });
});
