/**
 * SyncEngine media routing regression:
 *   - syncSendFile must stream upload progress into the Dexie message so
 *     the UI progress bar updates mid-upload (previously done inline in the
 *     IIFE pipeline; must not regress when the pipeline moves into the
 *     queue for crash-recovery).
 *   - syncSendFile must wire the upload through `uploadContent(…, progress,
 *     signal)` (HTTP URL path) — NOT `uploadContentMxc` — so the Abort
 *     plumbing and progress callback reach the Matrix SDK.
 *   - SyncEngine.cancelMediaUpload(clientId) must abort the in-flight
 *     upload AND delete the pending op so recoverStrandedOps does not
 *     resurrect a user-cancelled file after restart.
 *   - recoverStrandedOps(): a send_file op left in status="syncing" after
 *     a WebView crash must be reset to "pending" so the next processTick
 *     picks it up. Message status is reset too so the UI does not stick
 *     on "sending".
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Dexie from "dexie";
import "fake-indexeddb/auto";
import { SyncEngine } from "../sync-engine";
import type { PendingOperation, LocalMessage, LocalRoom, LocalAttachment } from "../schema";

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
  /** Upload that reports progress and honours AbortSignal. The production
   *  path uses this — not `uploadContentMxc` — so the SyncEngine handler
   *  must go through the same function. */
  uploadContent: vi.fn<
    (
      blob: Blob,
      progress?: (p: { loaded: number; total: number }) => void,
      signal?: AbortSignal,
    ) => Promise<string>
  >(async (_blob, progress) => {
    // Simulate three progress beats with hard-coded totals so happy-dom's
    // Blob.size quirks don't flake the test. The SyncEngine throttle drops
    // mid-cycle beats within 500ms — only the last (isFinal) must land.
    progress?.({ loaded: 300, total: 900 });
    progress?.({ loaded: 600, total: 900 });
    progress?.({ loaded: 900, total: 900 });
    return "https://server/_matrix/media/r0/download/server/abc123";
  }),
  uploadContentMxc: vi.fn<(blob: Blob) => Promise<string>>(async () => "mxc://server/file"),
};

vi.mock("@/entities/matrix", () => ({
  getMatrixClientService: () => mockMatrix,
}));

// --- Test DB -----------------------------------------------------------------

class TestDb extends Dexie {
  messages!: Dexie.Table<LocalMessage, number>;
  rooms!: Dexie.Table<LocalRoom, string>;
  pendingOps!: Dexie.Table<PendingOperation, number>;
  attachments!: Dexie.Table<LocalAttachment, number>;
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
  messageRepo: {
    confirmSent: ReturnType<typeof vi.fn>;
    updateStatus: ReturnType<typeof vi.fn>;
    getByEventId: ReturnType<typeof vi.fn>;
    updateReactions: ReturnType<typeof vi.fn>;
    getByClientId: ReturnType<typeof vi.fn>;
    updateUploadProgress: ReturnType<typeof vi.fn>;
  };
  roomRepo: { updateRoom: ReturnType<typeof vi.fn> };
  getRoomCrypto: ReturnType<typeof vi.fn>;
}

function makeHarness(name: string, encrypted: boolean): Harness {
  const db = new TestDb(name);
  const messageRepo = {
    confirmSent: vi.fn(async () => undefined),
    updateStatus: vi.fn(async () => undefined),
    getByEventId: vi.fn(async () => undefined),
    updateReactions: vi.fn(async () => undefined),
    getByClientId: vi.fn(async () => undefined),
    updateUploadProgress: vi.fn(async () => undefined),
  };
  const roomRepo = { updateRoom: vi.fn(async () => undefined) };
  const roomCrypto = encrypted
    ? {
        canBeEncrypt: () => true,
        requiresEncryption: () => true,
        encryptFile: async (blob: Blob) => ({
          file: new File([blob], "enc", { type: "application/octet-stream" }),
          secrets: { keys: "k", block: 10, v: 2 },
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

async function seedFileOp(
  db: TestDb,
  opts: { clientId: string; encrypted: boolean; attachmentId: number },
): Promise<number> {
  return db.pendingOps.add({
    type: "send_file",
    roomId: "!room:server",
    payload: {
      fileName: "photo.jpg",
      mimeType: "image/jpeg",
      msgtype: "m.image",
      attachmentId: opts.attachmentId,
    },
    status: "pending",
    retries: 0,
    maxRetries: 5,
    createdAt: Date.now(),
    clientId: opts.clientId,
    nextAttemptAt: 0,
  } as PendingOperation);
}

async function seedAttachment(db: TestDb, bytes = 300): Promise<number> {
  // Use a string body so happy-dom's Blob constructor reports the expected
  // byte length reliably (new Blob([Uint8Array]) has inconsistent .size
  // support across happy-dom versions).
  const blob = new Blob(["x".repeat(bytes)], { type: "image/jpeg" });
  return db.attachments.add({
    messageLocalId: 1,
    fileName: "photo.jpg",
    mimeType: "image/jpeg",
    size: bytes,
    localBlob: blob,
    status: "local",
  } as LocalAttachment);
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
// Tests
// ---------------------------------------------------------------------------

describe("SyncEngine.syncSendFile — full media pipeline", () => {
  let h: Harness;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    h?.engine.dispose();
    await h?.db.delete();
  });

  it("uploads via uploadContent (progress+signal path), not uploadContentMxc", async () => {
    h = makeHarness(`media-upload-${Date.now()}-${Math.random()}`, true);
    await h.db.open();

    const attachmentId = await seedAttachment(h.db);
    await seedFileOp(h.db, { clientId: "cli_file_up", encrypted: true, attachmentId });

    await h.engine.processQueue();
    await waitForProcessed(h.db);

    // Must use the progress-aware upload path — not the state-event upload.
    expect(mockMatrix.uploadContent).toHaveBeenCalledTimes(1);
    expect(mockMatrix.uploadContentMxc).not.toHaveBeenCalled();
  });

  it("streams upload progress into messages.uploadProgress via repo", async () => {
    h = makeHarness(`media-progress-${Date.now()}-${Math.random()}`, false);
    await h.db.open();

    const attachmentId = await seedAttachment(h.db, 900);
    await seedFileOp(h.db, {
      clientId: "cli_progress",
      encrypted: false,
      attachmentId,
    });

    await h.engine.processQueue();
    await waitForProcessed(h.db);

    // Three progress beats seeded by the mock; each must land on updateUploadProgress.
    const progressPercents = h.messageRepo.updateUploadProgress.mock.calls.map(
      (c) => c[1],
    );
    expect(progressPercents.length).toBeGreaterThanOrEqual(1);
    // Last value must be 100.
    expect(progressPercents[progressPercents.length - 1]).toBe(100);
    // Callback must be keyed by clientId.
    expect(h.messageRepo.updateUploadProgress.mock.calls[0][0]).toBe("cli_progress");
  });

  it("passes AbortSignal to uploadContent so the upload is cancellable", async () => {
    h = makeHarness(`media-abort-${Date.now()}-${Math.random()}`, false);
    await h.db.open();

    const attachmentId = await seedAttachment(h.db);
    await seedFileOp(h.db, {
      clientId: "cli_abort",
      encrypted: false,
      attachmentId,
    });

    await h.engine.processQueue();
    await waitForProcessed(h.db);

    expect(mockMatrix.uploadContent).toHaveBeenCalledTimes(1);
    const callArgs = mockMatrix.uploadContent.mock.calls[0];
    // Third arg is the AbortSignal
    expect(callArgs[2]).toBeInstanceOf(AbortSignal);
  });

  it("marks attachment uploaded + confirms message on success", async () => {
    h = makeHarness(`media-uploaded-${Date.now()}-${Math.random()}`, false);
    await h.db.open();

    const attachmentId = await seedAttachment(h.db);
    await seedFileOp(h.db, {
      clientId: "cli_ok",
      encrypted: false,
      attachmentId,
    });

    await h.engine.processQueue();
    await waitForProcessed(h.db);

    const att = await h.db.attachments.get(attachmentId);
    expect(att?.status).toBe("uploaded");
    expect(att?.remoteUrl).toMatch(/^https?:\/\//);

    expect(h.messageRepo.confirmSent).toHaveBeenCalledWith(
      "cli_ok",
      "$server_event_id",
    );
  });
});

describe("SyncEngine.recoverStrandedOps — send_file crash recovery", () => {
  let h: Harness;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    h?.engine.dispose();
    await h?.db.delete();
  });

  it("resets a 'syncing' send_file op to 'pending' and completes on next tick", async () => {
    h = makeHarness(`media-recover-${Date.now()}-${Math.random()}`, false);
    await h.db.open();

    const attachmentId = await seedAttachment(h.db);
    // Simulate a crash: op was mid-flight when WebView was killed.
    await h.db.pendingOps.add({
      type: "send_file",
      roomId: "!room:server",
      payload: {
        fileName: "crashed.jpg",
        mimeType: "image/jpeg",
        msgtype: "m.image",
        attachmentId,
      },
      status: "syncing",
      retries: 1,
      maxRetries: 5,
      createdAt: Date.now() - 10_000,
      clientId: "cli_crashed",
      nextAttemptAt: 0,
    } as PendingOperation);

    await h.engine.recoverStrandedOps();

    // Op must now be pending — ready for the scheduler to pick up.
    const recovered = await h.db.pendingOps
      .where("clientId")
      .equals("cli_crashed")
      .first();
    expect(recovered?.status).toBe("pending");

    // Next tick drains it — upload happens, op is deleted.
    await h.engine.processQueue();
    await waitForProcessed(h.db);

    expect(mockMatrix.uploadContent).toHaveBeenCalledTimes(1);
    expect(h.messageRepo.confirmSent).toHaveBeenCalledWith(
      "cli_crashed",
      "$server_event_id",
    );
  });
});

describe("SyncEngine.cancelMediaUpload — user cancel mid-flight", () => {
  let h: Harness;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    h?.engine.dispose();
    await h?.db.delete();
  });

  it("aborts the in-flight upload AND removes the pending op (no auto-resume)", async () => {
    h = makeHarness(`media-cancel-${Date.now()}-${Math.random()}`, false);
    await h.db.open();

    // Upload that blocks until its AbortSignal fires.
    const uploadStarted = new Promise<{ signal: AbortSignal; resolveFail: () => void }>(
      (resolve) => {
        mockMatrix.uploadContent.mockImplementationOnce(
          (_blob, _progress, signal) =>
            new Promise((_, reject) => {
              resolve({ signal: signal!, resolveFail: () => {} });
              signal?.addEventListener("abort", () => {
                reject(new DOMException("Upload cancelled", "AbortError"));
              });
            }),
        );
      },
    );

    const attachmentId = await seedAttachment(h.db);
    await seedFileOp(h.db, {
      clientId: "cli_cancel",
      encrypted: false,
      attachmentId,
    });

    h.engine.processQueue();

    // Wait until uploadContent is in flight.
    const { signal } = await uploadStarted;
    expect(signal.aborted).toBe(false);

    // User hits cancel.
    await h.engine.cancelMediaUpload("cli_cancel");

    // SyncEngine must abort the signal and delete the op so the scheduler
    // does not pick it back up.
    expect(signal.aborted).toBe(true);

    // Give the executeOperation catch block a moment to unwind.
    await new Promise((r) => setTimeout(r, 20));

    const remaining = await h.db.pendingOps
      .where("clientId")
      .equals("cli_cancel")
      .first();
    expect(remaining).toBeUndefined();
  });
});
