import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Dexie from "dexie";
import "fake-indexeddb/auto";
import { SyncEngine } from "../sync-engine";
import { MessageRepository } from "../message-repository";
import { RoomRepository } from "../room-repository";
import type { PendingOperation, LocalMessage, LocalRoom } from "../schema";

/**
 * Regression coverage for WEE-85 Part A: sending while the Matrix client is
 * temporarily not ready (boot / re-init window) must NOT fail instantly nor
 * burn retries. The SyncEngine's readiness gate releases a claimed op back to
 * "pending" without incrementing `retries` and re-polls until `isReady()`
 * turns true, at which point the queued message flushes normally.
 *
 * Before the fix, `use-messages.ts` flipped the message to "failed" the moment
 * `isReady()` was false — so a send issued right after app start was lost.
 *
 * Test-isolation note: the SyncEngine reads readiness from the GLOBAL
 * `getMatrixClientService()`. Sibling sync-engine suites share this mocked
 * module under reduced isolation, so we model "not ready" by ADDING an
 * `isReady` property to the shared mock only for the duration of a test and
 * stripping it again afterwards (the engine gates ONLY on an explicit
 * `isReady() === false`). The mock therefore looks exactly like every other
 * suite's mock — no `isReady` — at all times outside this file's test bodies.
 */

const mockMatrix: {
  isReady?: () => boolean;
  sendEncryptedText: ReturnType<typeof vi.fn>;
  sendText: ReturnType<typeof vi.fn>;
} = {
  sendEncryptedText: vi.fn(async () => "$server_event_id"),
  sendText: vi.fn(async () => "$server_event_id"),
};

/** Present `isReady() === false` (not ready) or strip it (ready). */
function setNotReady(notReady: boolean): void {
  if (notReady) mockMatrix.isReady = () => false;
  else delete mockMatrix.isReady;
}

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
  const getRoomCrypto = vi.fn(async () => undefined); // plaintext path
  const engine = new SyncEngine(db as never, messages as never, rooms as never, getRoomCrypto);
  return { db, engine, messages, rooms };
}

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

async function seedOp(db: TestDb, clientId: string): Promise<number> {
  return (await db.pendingOps.add({
    type: "send_message",
    roomId: ROOM_ID,
    payload: { content: "hello" },
    status: "pending",
    retries: 0,
    maxRetries: 5,
    createdAt: Date.now(),
    clientId,
    nextAttemptAt: 0,
  } as PendingOperation)) as number;
}

function waitTicks(n = 1): Promise<void> {
  return new Promise((resolve) => {
    let remaining = n;
    function next(): void {
      if (remaining-- <= 0) resolve();
      else setTimeout(next, 0);
    }
    next();
  });
}

describe("SyncEngine — WEE-85: queue while Matrix not ready", () => {
  let h: Harness;

  beforeEach(async () => {
    vi.clearAllMocks();
    setNotReady(false); // default: ready (no isReady property on the shared mock)
    mockMatrix.sendEncryptedText.mockImplementation(async () => "$server_event_id");
    h = makeHarness(`sync-engine-not-ready-${Date.now()}-${Math.random()}`);
    await h.db.open();
  });

  afterEach(async () => {
    // Strip the "not ready" override FIRST so the shared mock can never gate a
    // sibling suite's ops, even if teardown below throws.
    setNotReady(false);
    h.engine.dispose();
    await new Promise((r) => setTimeout(r, 0));
    await h.db.delete();
  });

  it("holds the op as pending without sending or burning a retry while not ready", async () => {
    setNotReady(true);
    try {
      await seedRoom(h.db);
      const msg = await h.messages.createLocal({
        roomId: ROOM_ID,
        senderId: "@me:server",
        content: "sent during boot",
      });
      await seedOp(h.db, msg.clientId);

      h.engine.processQueue();
      await waitTicks(4);

      const op = await h.db.pendingOps.where("clientId").equals(msg.clientId).first();
      const message = await h.messages.getByClientId(msg.clientId);
      // Invariants while not ready: the op is still queued (the gate cycles it
      // between "syncing" and "pending" on each re-poll, so assert it is not a
      // terminal "failed"), no send was attempted, no retry was consumed, and
      // the message itself was never flipped to "failed".
      expect(op).toBeDefined();
      expect(op?.status).not.toBe("failed");
      expect(op?.retries).toBe(0);
      expect(mockMatrix.sendEncryptedText).not.toHaveBeenCalled();
      expect(message?.status).toBe("pending");
    } finally {
      setNotReady(false);
    }
  });

  it("flushes the queued op once the client becomes ready", async () => {
    setNotReady(true);
    let opId: number;
    let clientId: string;
    try {
      await seedRoom(h.db);
      const msg = await h.messages.createLocal({
        roomId: ROOM_ID,
        senderId: "@me:server",
        content: "sent during boot",
      });
      clientId = msg.clientId;
      opId = await seedOp(h.db, msg.clientId);

      h.engine.processQueue();
      await waitTicks(4);
      expect(mockMatrix.sendEncryptedText).not.toHaveBeenCalled();
    } finally {
      // Client becomes ready (sync reached PREPARED).
      setNotReady(false);
    }

    // Clear the gate's scheduled re-poll delay so the test doesn't wait it out.
    await h.db.pendingOps.update(opId, { nextAttemptAt: 0 });
    h.engine.processQueue();

    await vi.waitFor(
      async () => {
        const op = await h.db.pendingOps.where("clientId").equals(clientId).first();
        expect(op).toBeUndefined(); // delivered → op deleted
      },
      { timeout: 2000, interval: 10 },
    );

    const message = await h.messages.getByClientId(clientId);
    expect(mockMatrix.sendEncryptedText).toHaveBeenCalledTimes(1);
    expect(message?.status).toBe("synced");
    expect(message?.eventId).toBe("$server_event_id");
  });
});
