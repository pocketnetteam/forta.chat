/**
 * Regression tests: every SyncEngine op handler that sends a Matrix event MUST
 * pass `op.clientId` as the txnId so the homeserver dedupes duplicate sends
 * (multi-tab races, network retries). Bug: `syncSendFile`, `syncEditMessage`,
 * and `syncSendTransfer` used to drop the txnId argument, so two tabs running
 * the same op could produce two server events and two visible bubbles — the
 * transfer case was the most painful because that's money.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Dexie from "dexie";
import "fake-indexeddb/auto";
import { SyncEngine } from "../sync-engine";
import type { PendingOperation, LocalMessage, LocalRoom } from "../schema";

// --- Mocks -------------------------------------------------------------------

const mockMatrix = {
  sendEncryptedText: vi.fn<
    (roomId: string, content: unknown, txnId?: string) => Promise<string>
  >(async () => "$server_event_id"),
  sendText: vi.fn<(roomId: string, text: string, txnId?: string) => Promise<string>>(
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
  uploadContentMxc: vi.fn<(blob: Blob) => Promise<string>>(async () => "mxc://server/file"),
  // syncSendFile goes through the progress-aware upload path (not uploadContentMxc).
  uploadContent: vi.fn<
    (
      blob: Blob,
      progress?: (p: { loaded: number; total: number }) => void,
      signal?: AbortSignal,
    ) => Promise<string>
  >(async () => "https://server/_matrix/media/r0/download/server/abc123"),
};

vi.mock("@/entities/matrix", () => ({
  getMatrixClientService: () => mockMatrix,
}));

// --- Test DB -----------------------------------------------------------------

class TestDb extends Dexie {
  messages!: Dexie.Table<LocalMessage, number>;
  rooms!: Dexie.Table<LocalRoom, string>;
  pendingOps!: Dexie.Table<PendingOperation, number>;
  attachments!: Dexie.Table<
    {
      id?: number;
      localBlob?: Blob;
      size?: number;
      status?: string;
      messageLocalId?: number;
    },
    number
  >;
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

// --- Helpers -----------------------------------------------------------------

interface Harness {
  db: TestDb;
  engine: SyncEngine;
  messageRepo: {
    confirmSent: ReturnType<typeof vi.fn>;
    updateStatus: ReturnType<typeof vi.fn>;
    getByEventId: ReturnType<typeof vi.fn>;
    updateReactions: ReturnType<typeof vi.fn>;
    getByClientId: ReturnType<typeof vi.fn>;
  };
  roomRepo: { updateRoom: ReturnType<typeof vi.fn> };
  getRoomCrypto: ReturnType<typeof vi.fn>;
}

function makeHarness(name: string, opts: { encrypted: boolean }): Harness {
  const db = new TestDb(name);
  const messageRepo = {
    confirmSent: vi.fn(async () => undefined),
    updateStatus: vi.fn(async () => undefined),
    getByEventId: vi.fn(async () => undefined),
    updateReactions: vi.fn(async () => undefined),
    getByClientId: vi.fn(async () => undefined),
  };
  const roomRepo = { updateRoom: vi.fn(async () => undefined) };
  const roomCrypto = opts.encrypted
    ? {
        canBeEncrypt: () => true,
        encryptEvent: async () => ({
          msgtype: "m.encrypted",
          body: "cipher",
          block: "b",
          version: 1,
        }),
        encryptFile: async (blob: Blob) => ({
          file: blob,
          secrets: { keys: "k" },
        }),
      }
    : undefined;
  const getRoomCrypto = vi.fn(async () => roomCrypto);
  const engine = new SyncEngine(
    db as never,
    messageRepo as never,
    roomRepo as never,
    getRoomCrypto as never,
  );
  return { db, engine, messageRepo, roomRepo, getRoomCrypto };
}

async function seedOp(
  db: TestDb,
  overrides: Partial<PendingOperation> = {},
): Promise<number> {
  return db.pendingOps.add({
    type: "send_message",
    roomId: "!room:server",
    payload: {},
    status: "pending",
    retries: 0,
    maxRetries: 5,
    createdAt: Date.now(),
    clientId: "cli_fixed_for_test",
    // Required for the [status+nextAttemptAt] compound index —
    // Dexie skips rows with undefined indexed keys.
    nextAttemptAt: 0,
    ...overrides,
  } as PendingOperation);
}

async function waitForProcessed(db: TestDb, timeoutMs = 1500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remaining = await db.pendingOps.count();
    if (remaining === 0) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("pendingOps queue did not drain in time");
}

// ---------------------------------------------------------------------------
// Tests — one per op handler that was previously dropping clientId
// ---------------------------------------------------------------------------

describe("SyncEngine txnId propagation (regression)", () => {
  let h: Harness;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await h.db.delete();
  });

  it("syncSendFile passes op.clientId as the Matrix txnId", async () => {
    h = makeHarness(`txnid-file-${Date.now()}-${Math.random()}`, { encrypted: true });
    await h.db.open();
    // Attachment blob required by syncSendFile
    const attachmentId = await h.db.attachments.add({
      messageLocalId: 1,
      localBlob: new Blob(["hi"], { type: "text/plain" }),
      size: 2,
      status: "local",
    });

    await seedOp(h.db, {
      type: "send_file",
      clientId: "cli_file_1",
      payload: {
        fileName: "test.txt",
        mimeType: "text/plain",
        msgtype: "m.file",
        attachmentId,
      },
    });

    await h.engine.processQueue();
    await waitForProcessed(h.db);

    expect(mockMatrix.sendEncryptedText).toHaveBeenCalledTimes(1);
    const [roomId, , txnId] = mockMatrix.sendEncryptedText.mock.calls[0];
    expect(roomId).toBe("!room:server");
    expect(txnId).toBe("cli_file_1");
  });

  it("syncEditMessage passes op.clientId as the Matrix txnId", async () => {
    h = makeHarness(`txnid-edit-${Date.now()}-${Math.random()}`, { encrypted: true });
    await h.db.open();

    await seedOp(h.db, {
      type: "edit_message",
      clientId: "cli_edit_1",
      payload: { eventId: "$old_event", newContent: "updated body" },
    });

    await h.engine.processQueue();
    await waitForProcessed(h.db);

    expect(mockMatrix.sendEncryptedText).toHaveBeenCalledTimes(1);
    const [, , txnId] = mockMatrix.sendEncryptedText.mock.calls[0];
    expect(txnId).toBe("cli_edit_1");
  });

  it("syncSendTransfer (encrypted) passes op.clientId as the Matrix txnId", async () => {
    h = makeHarness(`txnid-xfer-enc-${Date.now()}-${Math.random()}`, { encrypted: true });
    await h.db.open();

    await seedOp(h.db, {
      type: "send_transfer",
      clientId: "cli_xfer_enc_1",
      payload: {
        txId: "abc123",
        amount: 1.5,
        from: "PxAlice",
        to: "PxBob",
        message: "thanks",
      },
    });

    await h.engine.processQueue();
    await waitForProcessed(h.db);

    expect(mockMatrix.sendEncryptedText).toHaveBeenCalledTimes(1);
    const [, , txnId] = mockMatrix.sendEncryptedText.mock.calls[0];
    expect(txnId).toBe("cli_xfer_enc_1");
  });

  it("syncSendTransfer (plain) passes op.clientId as the Matrix txnId", async () => {
    h = makeHarness(`txnid-xfer-plain-${Date.now()}-${Math.random()}`, { encrypted: false });
    await h.db.open();

    await seedOp(h.db, {
      type: "send_transfer",
      clientId: "cli_xfer_plain_1",
      payload: {
        txId: "def456",
        amount: 0.25,
        from: "PxAlice",
        to: "PxBob",
      },
    });

    await h.engine.processQueue();
    await waitForProcessed(h.db);

    expect(mockMatrix.sendText).toHaveBeenCalledTimes(1);
    const [, , txnId] = mockMatrix.sendText.mock.calls[0];
    expect(txnId).toBe("cli_xfer_plain_1");
    // And nothing leaked to the encrypted path
    expect(mockMatrix.sendEncryptedText).not.toHaveBeenCalled();
  });
});
