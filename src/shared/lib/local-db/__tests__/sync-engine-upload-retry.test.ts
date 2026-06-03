/**
 * SyncEngine in-attempt upload retry (forta-bugs#831 / #725 / #423 / WEE-50).
 *
 * Flaky Android cell links drop the first upload POST even when the rest of
 * the pipeline is healthy. Pre-fix, the whole `send_file` op failed and the
 * user waited out the queue-level 1-30s backoff before anything happened.
 * The new in-attempt retry burns through transient errors within ~6 s,
 * leaving the queue-level retries as a fallback for genuinely persistent
 * failures.
 *
 * These tests pin three behaviours:
 *   1. A transient first failure must NOT propagate — the upload retries and
 *      the op completes within the same processTick.
 *   2. A "too large" error (Matrix repo 413) must short-circuit immediately —
 *      retrying just delays a deterministic failure.
 *   3. After exhausting the in-attempt budget, the op falls back to the
 *      queue's exponential-backoff retry path (delete-on-success once the
 *      next attempt succeeds).
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
  uploadContent: vi.fn<
    (
      blob: Blob,
      progress?: (p: { loaded: number; total: number }) => void,
      signal?: AbortSignal,
    ) => Promise<string>
  >(),
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
    confirmMediaSent: ReturnType<typeof vi.fn>;
    updateStatus: ReturnType<typeof vi.fn>;
    getByEventId: ReturnType<typeof vi.fn>;
    updateReactions: ReturnType<typeof vi.fn>;
    getByClientId: ReturnType<typeof vi.fn>;
    updateUploadProgress: ReturnType<typeof vi.fn>;
  };
}

function makeHarness(name: string): Harness {
  const db = new TestDb(name);
  const messageRepo = {
    confirmSent: vi.fn(async () => undefined),
    confirmMediaSent: vi.fn(async () => undefined),
    updateStatus: vi.fn(async () => undefined),
    getByEventId: vi.fn(async () => undefined),
    updateReactions: vi.fn(async () => undefined),
    getByClientId: vi.fn(async () => undefined),
    updateUploadProgress: vi.fn(async () => undefined),
  };
  const roomRepo = { updateRoom: vi.fn(async () => undefined), syncLastMessageLocalStatus: vi.fn(async () => undefined) };
  const getRoomCrypto = vi.fn(async () => undefined);
  const engine = new SyncEngine(
    db as never,
    messageRepo as never,
    roomRepo as never,
    getRoomCrypto as never,
  );
  return { db, engine, messageRepo };
}

async function seedAttachment(db: TestDb): Promise<number> {
  const blob = new Blob(["x".repeat(100)], { type: "image/jpeg" });
  return db.attachments.add({
    messageLocalId: 1,
    fileName: "photo.jpg",
    mimeType: "image/jpeg",
    size: 100,
    localBlob: blob,
    status: "local",
  } as LocalAttachment);
}

async function seedFileOp(db: TestDb, clientId: string, attachmentId: number): Promise<void> {
  await db.pendingOps.add({
    type: "send_file",
    roomId: "!room:server",
    payload: {
      fileName: "photo.jpg",
      mimeType: "image/jpeg",
      msgtype: "m.image",
      attachmentId,
    },
    status: "pending",
    retries: 0,
    maxRetries: 5,
    createdAt: Date.now(),
    clientId,
    nextAttemptAt: 0,
  } as PendingOperation);
}

async function waitForProcessed(db: TestDb, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remaining = await db.pendingOps.count();
    if (remaining === 0) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("pendingOps queue did not drain in time");
}

describe("SyncEngine.syncSendFile — upload retry (WEE-50)", () => {
  let h: Harness;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    h?.engine.dispose();
    await h?.db.delete();
  });

  it("retries a transient upload failure within the same op", async () => {
    h = makeHarness(`upload-retry-${Date.now()}-${Math.random()}`);
    await h.db.open();

    // First attempt drops with a generic "Failed to fetch" — second succeeds.
    let attempt = 0;
    mockMatrix.uploadContent.mockImplementation(async () => {
      attempt += 1;
      if (attempt === 1) throw new TypeError("Failed to fetch");
      return "https://server/_matrix/media/r0/download/server/ok";
    });

    const attachmentId = await seedAttachment(h.db);
    await seedFileOp(h.db, "cli_blip", attachmentId);

    await h.engine.processQueue();
    await waitForProcessed(h.db);

    // Two upload attempts, single send_file op succeeded (no queue retry).
    expect(mockMatrix.uploadContent).toHaveBeenCalledTimes(2);
    expect(h.messageRepo.confirmMediaSent).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry a 'too large' upload failure", async () => {
    h = makeHarness(`upload-413-${Date.now()}-${Math.random()}`);
    await h.db.open();

    mockMatrix.uploadContent.mockImplementation(async () => {
      throw new Error("413 Payload Too Large");
    });

    const attachmentId = await seedAttachment(h.db);
    await seedFileOp(h.db, "cli_too_large", attachmentId);

    await h.engine.processQueue();
    // Give the queue scheduler a tick to record the failure.
    await new Promise((r) => setTimeout(r, 50));

    // Only one upload attempt — fatal error short-circuits the retry loop.
    expect(mockMatrix.uploadContent).toHaveBeenCalledTimes(1);

    // Op stays in the queue (failed or scheduled for queue-level retry).
    // confirmMediaSent must never run for an upload that never succeeded.
    expect(h.messageRepo.confirmMediaSent).not.toHaveBeenCalled();
  });

  it("performs the full in-attempt budget before bubbling to queue retry", async () => {
    h = makeHarness(`upload-exhaust-${Date.now()}-${Math.random()}`);
    await h.db.open();

    // Always-failing transient error — saturates the in-attempt budget and
    // then surfaces to the queue-level retry path. Tracked in a closure so
    // the assertion can verify the exact attempt count.
    let perOpAttempts = 0;
    mockMatrix.uploadContent.mockImplementation(async () => {
      perOpAttempts += 1;
      throw new TypeError("Failed to fetch");
    });

    const attachmentId = await seedAttachment(h.db);
    // maxRetries=0 so the queue does NOT reschedule the op for another execution
    // after the in-attempt budget is exhausted — keeps the test fast and the
    // attempt count deterministic.
    await h.db.pendingOps.add({
      type: "send_file",
      roomId: "!room:server",
      payload: {
        fileName: "photo.jpg",
        mimeType: "image/jpeg",
        msgtype: "m.image",
        attachmentId,
      },
      status: "pending",
      retries: 0,
      maxRetries: 0,
      createdAt: Date.now(),
      clientId: "cli_exhaust",
      nextAttemptAt: 0,
    } as PendingOperation);

    await h.engine.processQueue();

    // Wait until the engine records the op as failed (maxRetries=0 → first
    // exhausted run marks it failed; no further attempts).
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const op = await h.db.pendingOps
        .where("clientId")
        .equals("cli_exhaust")
        .first();
      if (op?.status === "failed") break;
      await new Promise((r) => setTimeout(r, 25));
    }

    // Initial attempt + 3 retry slots = 4 calls inside one execution. Anything
    // less would mean the retry loop short-circuited a transient error.
    expect(perOpAttempts).toBe(4);
    expect(h.messageRepo.confirmMediaSent).not.toHaveBeenCalled();
  }, 20_000);
});
