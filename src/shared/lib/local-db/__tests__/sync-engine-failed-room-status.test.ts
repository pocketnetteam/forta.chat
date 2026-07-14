import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Dexie from "dexie";
import "fake-indexeddb/auto";
import { SyncEngine } from "../sync-engine";
import { MessageRepository } from "../message-repository";
import { RoomRepository } from "../room-repository";
import type { PendingOperation, LocalMessage, LocalRoom } from "../schema";
import { disposeSyncEngineHarness } from "./sync-engine-test-helpers";

/**
 * Regression coverage for WEE-64: the chat-list preview must reflect the real
 * transport status of the last outbound message, the same way the open chat
 * does. The bug: `SyncEngine.markMessageFailed` only flipped the per-message
 * `LocalMessage.status` to "failed" and never touched the denormalised
 * `LocalRoom.lastMessageLocalStatus` that drives the sidebar preview — so the
 * preview stayed stuck on "sending" (часики) after a failed send.
 *
 * The fix mirrors the success path (`sync-engine.ts:607-610`) but guards the
 * write twice:
 *   (a) only outbound send-ops (send_message/send_file/send_transfer/send_poll)
 *       — an edit/reaction failure must not corrupt the preview badge;
 *   (b) only when the failed message is STILL the room's last message — a newer
 *       message (ours or the peer's) already advanced the preview.
 * On retry the preview must return to "pending" (sending) symmetrically.
 */

const mockMatrix = {
  sendEncryptedText: vi.fn<
    (roomId: string, content: unknown, clientId?: string) => Promise<string>
  >(async () => "$server_event_id"),
  sendText: vi.fn<(roomId: string, body: unknown, clientId?: string) => Promise<string>>(
    async () => "$server_event_id",
  ),
  sendReaction: vi.fn<(roomId: string, eventId: string, emoji: string) => Promise<string>>(
    async () => "$reaction_id",
  ),
  redactEvent: vi.fn<(roomId: string, eventId: string) => Promise<void>>(async () => undefined),
  sendPollStart: vi.fn<(roomId: string, content: unknown) => Promise<string>>(
    async () => "$poll_id",
  ),
  sendPollResponse: vi.fn<(roomId: string, content: unknown) => Promise<void>>(
    async () => undefined,
  ),
};

vi.mock("@/entities/matrix", () => ({
  getMatrixClientService: () => mockMatrix,
}));

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

interface Harness {
  db: TestDb;
  engine: SyncEngine;
  messages: MessageRepository;
  rooms: RoomRepository;
}

const ROOM_ID = "!room:server";

function makeHarness(name: string): Harness {
  const db = new TestDb(name);
  const messages = new MessageRepository(db as never);
  const rooms = new RoomRepository(db as never);
  const getRoomCrypto = vi.fn(async () => ({
    canBeEncrypt: () => true,
    encryptEvent: async (content: string) => ({ body: content, msgtype: "m.text" }),
  })) as never;
  const engine = new SyncEngine(db as never, messages as never, rooms as never, getRoomCrypto);
  return { db, engine, messages, rooms };
}

function seedRoom(db: TestDb, overrides: Partial<LocalRoom> = {}): Promise<string> {
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
    ...overrides,
  };
  return db.rooms.put(room).then(() => room.id);
}

async function seedOp(
  db: TestDb,
  overrides: Partial<PendingOperation> = {},
): Promise<number> {
  return db.pendingOps.add({
    type: "send_message",
    roomId: ROOM_ID,
    payload: { content: "hello" },
    status: "pending",
    retries: 0,
    maxRetries: 1,
    createdAt: Date.now(),
    clientId: `cli_${Math.random().toString(36).slice(2)}`,
    nextAttemptAt: 0,
    ...overrides,
  } as PendingOperation);
}

/** A genuinely-failed send leaves its op row in the table with status "failed"
 *  (it is only deleted when an echo already confirmed it). Wait for that. */
async function waitOpFailed(db: TestDb, clientId: string): Promise<void> {
  await vi.waitFor(
    async () => {
      const op = await db.pendingOps.where("clientId").equals(clientId).first();
      expect(op?.status).toBe("failed");
    },
    { timeout: 2000, interval: 10 },
  );
}

describe("SyncEngine — WEE-64: chat-list preview reflects failed/retried send", () => {
  let h: Harness;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockMatrix.sendEncryptedText.mockImplementation(async () => "$server_event_id");
    h = makeHarness(`sync-engine-failed-room-status-${Date.now()}-${Math.random()}`);
    await h.db.open();
  });

  afterEach(async () => {
    await disposeSyncEngineHarness(h);
  });

  it("markMessageFailed sets room.lastMessageLocalStatus='failed' for the last message", async () => {
    await seedRoom(h.db);
    const msg = await h.messages.createLocal({
      roomId: ROOM_ID,
      senderId: "@me:server",
      content: "boom",
    });
    // Preconditions: writeOutbound primed the preview to "pending".
    expect((await h.db.rooms.get(ROOM_ID))?.lastMessageLocalStatus).toBe("pending");

    mockMatrix.sendEncryptedText.mockImplementation(async () => {
      throw new Error("permanent network failure");
    });

    await seedOp(h.db, { clientId: msg.clientId, maxRetries: 1 });
    await h.engine.processQueue();
    await waitOpFailed(h.db, msg.clientId);

    await vi.waitFor(
      async () => {
        const message = await h.messages.getByClientId(msg.clientId);
        expect(message?.status).toBe("failed");
      },
      { timeout: 3000, interval: 20 },
    );
    await vi.waitFor(
      async () => {
        const room = await h.db.rooms.get(ROOM_ID);
        expect(room?.lastMessageLocalStatus).toBe("failed");
      },
      { timeout: 3000, interval: 20 },
    );
  });

  it("does NOT touch room status when the failed message is not the room's last", async () => {
    await seedRoom(h.db);
    const stale = await h.messages.createLocal({
      roomId: ROOM_ID,
      senderId: "@me:server",
      content: "stale",
    });
    // Simulate a newer message having advanced the preview to a later timestamp
    // and a delivered (synced) status.
    await h.db.rooms.update(ROOM_ID, {
      lastMessageTimestamp: stale.timestamp + 10_000,
      lastMessageLocalStatus: "synced",
    });

    mockMatrix.sendEncryptedText.mockImplementation(async () => {
      throw new Error("permanent network failure");
    });

    await seedOp(h.db, { clientId: stale.clientId, maxRetries: 1 });
    await h.engine.processQueue();
    await waitOpFailed(h.db, stale.clientId);

    const message = await h.messages.getByClientId(stale.clientId);
    const room = await h.db.rooms.get(ROOM_ID);
    // The message itself is failed, but the preview belongs to a newer message.
    expect(message?.status).toBe("failed");
    expect(room?.lastMessageLocalStatus).toBe("synced");
  });

  it("edit/reaction failure does NOT corrupt lastMessageLocalStatus", async () => {
    await seedRoom(h.db, {
      lastMessageTimestamp: 5000,
      lastMessageLocalStatus: "synced",
    });

    mockMatrix.sendEncryptedText.mockImplementation(async () => {
      throw new Error("edit send failed");
    });
    mockMatrix.sendReaction.mockImplementation(async () => {
      throw new Error("reaction send failed");
    });

    await seedOp(h.db, {
      type: "edit_message",
      clientId: "edit_cli",
      payload: { eventId: "$evt", content: "edited" },
      maxRetries: 1,
    });
    await h.engine.processQueue();
    await waitOpFailed(h.db, "edit_cli");

    const room = await h.db.rooms.get(ROOM_ID);
    expect(room?.lastMessageLocalStatus).toBe("synced");
  });

  it("retryAllFailed resets a failed last-message preview back to 'pending'", async () => {
    await seedRoom(h.db);
    const msg = await h.messages.createLocal({
      roomId: ROOM_ID,
      senderId: "@me:server",
      content: "retry me",
    });
    // Simulate the parked failed end-state: per-message status + preview both
    // "failed", op left in the queue as "failed" (as after retry exhaustion).
    await h.messages.updateStatus({ clientId: msg.clientId }, "failed");
    await h.rooms.updateRoom(ROOM_ID, { lastMessageLocalStatus: "failed" });
    await seedOp(h.db, { clientId: msg.clientId, status: "failed", retries: 1, maxRetries: 1 });

    // Hang the in-flight retry send so we can observe the reset-to-pending
    // transition deterministically, without the op immediately re-failing.
    mockMatrix.sendEncryptedText.mockImplementation(() => new Promise<string>(() => {}));

    await h.engine.retryAllFailed();

    const room = await h.db.rooms.get(ROOM_ID);
    expect(room?.lastMessageLocalStatus).toBe("pending");
  });

  it("RoomRepository.syncLastMessageLocalStatus only writes when timestamp matches", async () => {
    await seedRoom(h.db, { lastMessageTimestamp: 1000, lastMessageLocalStatus: "synced" });

    // Non-matching timestamp → no-op.
    await h.rooms.syncLastMessageLocalStatus(ROOM_ID, 999, "failed");
    expect((await h.db.rooms.get(ROOM_ID))?.lastMessageLocalStatus).toBe("synced");

    // Matching timestamp → writes.
    await h.rooms.syncLastMessageLocalStatus(ROOM_ID, 1000, "failed");
    expect((await h.db.rooms.get(ROOM_ID))?.lastMessageLocalStatus).toBe("failed");

    // Unknown room → no throw.
    await expect(
      h.rooms.syncLastMessageLocalStatus("!nope:server", 1000, "failed"),
    ).resolves.toBeUndefined();
  });
});
