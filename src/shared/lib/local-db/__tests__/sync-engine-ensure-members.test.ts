/**
 * SyncEngine completes the room's participant list (PcryptoRoomInstance
 * .ensureMembers) BEFORE canBeEncrypt() decides between encrypting and
 * refusing. With lazy-loaded members a fresh 1:1 room has no peer until the
 * list is loaded: deciding first made the send fail with
 * ENCRYPTION_REQUIRED_NO_KEYS although the peer had published keys, and a
 * group would derive its common key from part of the room.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import Dexie from "dexie";
import "fake-indexeddb/auto";
import { SyncEngine } from "../sync-engine";
import type { PendingOperation, LocalMessage, LocalRoom } from "../schema";
import { disposeSyncEngineHarness, waitTicks } from "./sync-engine-test-helpers";

const mockMatrix = {
  sendEncryptedText: vi.fn<(roomId: string, content: unknown, txnId?: string) => Promise<string>>(
    async () => "$server_event_id",
  ),
  sendText: vi.fn<(roomId: string, text: string, txnId?: string) => Promise<string>>(async () => "$server_event_id"),
};

vi.mock("@/entities/matrix", () => ({
  getMatrixClientService: () => mockMatrix,
}));

class TestDb extends Dexie {
  messages!: Dexie.Table<LocalMessage, number>;
  rooms!: Dexie.Table<LocalRoom, string>;
  pendingOps!: Dexie.Table<PendingOperation, number>;
  attachments!: Dexie.Table<{ id?: number }, number>;
  users!: Dexie.Table<{ address: string }, string>;
  syncState!: Dexie.Table<{ key: string; value: string | number }, string>;
  decryptionQueue!: Dexie.Table<{ id?: number; status: string }, number>;
  listenedMessages!: Dexie.Table<{ messageId: string }, string>;

  constructor(name: string) {
    super(name, { indexedDB, IDBKeyRange });
    this.version(1).stores({
      messages: "++localId, eventId, clientId, [roomId+timestamp], [roomId+status], senderId",
      rooms: "id, updatedAt, membership, isDeleted",
      pendingOps: "++id, [roomId+createdAt], status, clientId, [status+nextAttemptAt]",
      attachments: "++id, messageLocalId, status",
      users: "address, updatedAt",
      syncState: "key",
      decryptionQueue: "++id, status, [status+nextAttemptAt]",
      listenedMessages: "messageId",
    });
  }
}

/** A private 1:1 room whose peer is known only after ensureMembers(). */
function makeHarness(ensureMembers: () => Promise<void>) {
  const db = new TestDb(`ensure-members-${Date.now()}-${Math.random()}`);
  let membersComplete = false;
  const roomCrypto = {
    ensureMembers: vi.fn(async () => {
      await ensureMembers();
      membersComplete = true;
    }),
    canBeEncrypt: () => membersComplete,
    requiresEncryption: () => true,
    encryptEvent: vi.fn(async () => ({ msgtype: "m.encrypted", body: "cipher", block: 1, version: 2 })),
  };
  const messageRepo = {
    confirmSent: vi.fn(async () => undefined),
    updateStatus: vi.fn(async () => undefined),
    getByEventId: vi.fn(async () => undefined),
    getByClientId: vi.fn(async () => undefined),
  };
  const roomRepo = { updateRoom: vi.fn(async () => undefined), syncLastMessageLocalStatus: vi.fn(async () => undefined) };
  const engine = new SyncEngine(db as never, messageRepo as never, roomRepo as never, (async () => roomCrypto) as never);
  return { db, engine, roomCrypto };
}

async function seedOp(db: TestDb, overrides: Partial<PendingOperation>): Promise<void> {
  await db.pendingOps.add({
    roomId: "!room:server",
    status: "pending",
    retries: 0,
    maxRetries: 5,
    createdAt: Date.now(),
    clientId: "cli_1",
    nextAttemptAt: 0,
    ...overrides,
  } as PendingOperation);
}

describe("SyncEngine — participants complete before the encrypt decision", () => {
  let h: ReturnType<typeof makeHarness>;

  afterEach(async () => {
    vi.clearAllMocks();
    await disposeSyncEngineHarness(h);
  });

  it("send_message encrypts once the members are loaded", async () => {
    h = makeHarness(async () => {});
    await h.db.open();
    await seedOp(h.db, { type: "send_message", payload: { content: "hi" } });

    await h.engine.processQueue();
    await vi.waitFor(() => expect(mockMatrix.sendEncryptedText).toHaveBeenCalledTimes(1));

    expect(h.roomCrypto.ensureMembers).toHaveBeenCalled();
    expect(h.roomCrypto.encryptEvent).toHaveBeenCalledWith("hi");
    expect(mockMatrix.sendText).not.toHaveBeenCalled();
  });

  it("edit_message encrypts once the members are loaded", async () => {
    h = makeHarness(async () => {});
    await h.db.open();
    await seedOp(h.db, { type: "edit_message", payload: { eventId: "$old", newContent: "fixed" } });

    await h.engine.processQueue();
    await vi.waitFor(() => expect(mockMatrix.sendEncryptedText).toHaveBeenCalledTimes(1));
    expect(h.roomCrypto.ensureMembers).toHaveBeenCalled();
  });

  it("sends nothing when the members cannot be loaded", async () => {
    h = makeHarness(async () => {
      throw new Error("loadMembersIfNeeded timed out");
    });
    await h.db.open();
    await seedOp(h.db, { type: "send_message", payload: { content: "hi" } });

    await h.engine.processQueue();
    await waitTicks(20);

    expect(h.roomCrypto.ensureMembers).toHaveBeenCalled();
    expect(mockMatrix.sendEncryptedText).not.toHaveBeenCalled();
    expect(mockMatrix.sendText).not.toHaveBeenCalled();
  });
});
