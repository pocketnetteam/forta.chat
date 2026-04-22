import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Dexie from "dexie";
import "fake-indexeddb/auto";
import { SyncEngine } from "../sync-engine";
import type { PendingOperation, LocalMessage, LocalRoom } from "../schema";

// --- Module mocks ------------------------------------------------------------

// Mock matrix client service so syncSendMessage has a working dependency.
// Tests can override the sendEncryptedText impl per-case via `mockMatrix`.
const mockMatrix = {
  sendEncryptedText: vi.fn<
    (roomId: string, content: unknown, clientId?: string) => Promise<string>
  >(async () => "$server_event_id"),
  sendText: vi.fn<(roomId: string, body: string) => Promise<string>>(async () => "$server_event_id"),
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
};

vi.mock("@/entities/matrix", () => ({
  getMatrixClientService: () => mockMatrix,
}));

// --- Test DB -----------------------------------------------------------------

class TestDb extends Dexie {
  messages!: Dexie.Table<LocalMessage, number>;
  rooms!: Dexie.Table<LocalRoom, string>;
  pendingOps!: Dexie.Table<PendingOperation, number>;
  attachments!: Dexie.Table<{ id?: number; localBlob?: Blob; size?: number }, number>;
  users!: Dexie.Table<{ address: string }, string>;
  syncState!: Dexie.Table<{ key: string; value: string | number }, string>;
  decryptionQueue!: Dexie.Table<{ id?: number; status: string }, number>;
  listenedMessages!: Dexie.Table<{ messageId: string }, string>;

  constructor(name: string) {
    super(name, { indexedDB, IDBKeyRange });
    // Schema matches the migration we're about to add (v11): adds `nextAttemptAt`
    // to the pendingOps compound index so the engine can query due ops.
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
  messageRepo: { confirmSent: ReturnType<typeof vi.fn>; updateStatus: ReturnType<typeof vi.fn>; getByEventId: ReturnType<typeof vi.fn>; updateReactions: ReturnType<typeof vi.fn>; getByClientId: ReturnType<typeof vi.fn> };
  roomRepo: { updateRoom: ReturnType<typeof vi.fn> };
  getRoomCrypto: ReturnType<typeof vi.fn>;
}

function makeHarness(name: string): Harness {
  const db = new TestDb(name);
  const messageRepo = {
    confirmSent: vi.fn(async () => undefined),
    updateStatus: vi.fn(async () => undefined),
    getByEventId: vi.fn(async () => undefined),
    updateReactions: vi.fn(async () => undefined),
    getByClientId: vi.fn(async () => undefined),
  };
  const roomRepo = {
    updateRoom: vi.fn(async () => undefined),
  };
  const getRoomCrypto = vi.fn(async () => undefined); // plain-text path by default
  const engine = new SyncEngine(
    db as never,
    messageRepo as never,
    roomRepo as never,
    getRoomCrypto,
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
    payload: { content: "hello" },
    status: "pending",
    retries: 0,
    maxRetries: 5,
    createdAt: Date.now(),
    clientId: `cli_${Math.random().toString(36).slice(2)}`,
    // Production `enqueue()` always sets this; tests that write directly to
    // the DB must too, otherwise the compound [status+nextAttemptAt] index
    // skips the record (Dexie excludes rows where any indexed key is undefined).
    nextAttemptAt: 0,
    ...overrides,
  } as PendingOperation);
}

function waitTicks(n = 1): Promise<void> {
  // Let the event loop drain: each await yields one microtask tick,
  // and setTimeout(0) yields one macrotask tick.
  return new Promise((resolve) => {
    let remaining = n;
    function next() {
      if (remaining-- <= 0) resolve();
      else setTimeout(next, 0);
    }
    next();
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SyncEngine — non-blocking backoff (head-of-line isolation)", () => {
  let h: Harness;

  beforeEach(async () => {
    vi.clearAllMocks();
    h = makeHarness(`sync-engine-hol-${Date.now()}-${Math.random()}`);
    await h.db.open();
  });

  afterEach(async () => {
    h.engine.dispose();
    await h.db.delete();
  });

  it("does not block subsequent ops for 30s when first op fails", async () => {
    // First op fails with retryable error; remaining ops succeed.
    let call = 0;
    mockMatrix.sendEncryptedText.mockImplementation(async () => {
      call++;
      if (call === 1) throw new Error("transient network");
      return "$server_event_id";
    });

    await seedOp(h.db, { clientId: "op_1", roomId: "!r1:s", payload: { content: "first" } });
    await seedOp(h.db, { clientId: "op_2", roomId: "!r2:s", payload: { content: "second" } });
    await seedOp(h.db, { clientId: "op_3", roomId: "!r3:s", payload: { content: "third" } });

    const start = Date.now();
    h.engine.processQueue(); // fire-and-forget kick

    // Wait for ops 2 and 3 to have been processed.
    await vi.waitFor(
      async () => {
        const remaining = await h.db.pendingOps
          .where("status")
          .equals("pending")
          .count();
        // op_1 stays pending (scheduled for retry), op_2 and op_3 should be gone.
        expect(remaining).toBeLessThanOrEqual(1);
      },
      { timeout: 2000, interval: 10 },
    );

    const elapsed = Date.now() - start;
    // If the engine blocked the loop with `await sleep(delay)` on the first op,
    // this test wouldn't finish under 2s (minimum backoff is 2_000ms).
    expect(elapsed).toBeLessThan(2000);

    // op_1 should be back as pending (scheduled), ops 2 & 3 processed.
    const leftover = await h.db.pendingOps.toArray();
    expect(leftover.length).toBe(1);
    expect(leftover[0].clientId).toBe("op_1");
    expect(leftover[0].status).toBe("pending");
    expect(leftover[0].retries).toBe(1);
  });

  it("schedules retry via nextAttemptAt instead of blocking the queue", async () => {
    mockMatrix.sendEncryptedText.mockImplementationOnce(async () => {
      throw new Error("temporary");
    });
    mockMatrix.sendEncryptedText.mockImplementationOnce(async () => "$ok");

    await seedOp(h.db, { clientId: "op_retry" });
    h.engine.processQueue();

    // After first failure, op is pending with nextAttemptAt in the future.
    await vi.waitFor(
      async () => {
        const op = await h.db.pendingOps.where("clientId").equals("op_retry").first();
        expect(op?.retries).toBe(1);
      },
      { timeout: 500, interval: 10 },
    );

    const pendingOp = await h.db.pendingOps.where("clientId").equals("op_retry").first();
    expect(pendingOp?.status).toBe("pending");
    // A retry schedule must exist so other workers know not to pick it up yet.
    expect(pendingOp).toHaveProperty("nextAttemptAt");
    expect((pendingOp as unknown as { nextAttemptAt: number }).nextAttemptAt).toBeGreaterThan(
      Date.now(),
    );
  });
});

describe("SyncEngine — setOnline(true) retries failed ops", () => {
  let h: Harness;

  beforeEach(async () => {
    vi.clearAllMocks();
    h = makeHarness(`sync-engine-online-${Date.now()}-${Math.random()}`);
    await h.db.open();
  });

  afterEach(async () => {
    h.engine.dispose();
    await h.db.delete();
  });

  it("resets failed ops to pending when connection is restored", async () => {
    await seedOp(h.db, {
      clientId: "failed_op",
      status: "failed",
      retries: 5,
      maxRetries: 5,
      errorMessage: "gave up",
    });
    mockMatrix.sendEncryptedText.mockResolvedValue("$recovered");

    h.engine.setOnline(false);
    h.engine.setOnline(true);

    await vi.waitFor(
      async () => {
        const remaining = await h.db.pendingOps.count();
        expect(remaining).toBe(0); // successfully processed & deleted
      },
      { timeout: 1000, interval: 10 },
    );

    expect(mockMatrix.sendEncryptedText).toHaveBeenCalled();
  });
});

describe("SyncEngine — transactional op claim", () => {
  let h: Harness;

  beforeEach(async () => {
    vi.clearAllMocks();
    h = makeHarness(`sync-engine-tx-${Date.now()}-${Math.random()}`);
    await h.db.open();
  });

  afterEach(async () => {
    h.engine.dispose();
    await h.db.delete();
  });

  it("two independent engines on same DB must not both execute the same op", async () => {
    // Slow send so both concurrent claims race on the same record.
    mockMatrix.sendEncryptedText.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 20));
      return "$ok";
    });

    // Second engine instance on the SAME db (simulates multi-tab browser).
    const engineB = new SyncEngine(
      h.db as never,
      h.messageRepo as never,
      h.roomRepo as never,
      h.getRoomCrypto as never,
    );

    await seedOp(h.db, { clientId: "op_race" });

    // Kick off both engines concurrently. A non-transactional claim would
    // let both engines invoke sendEncryptedText (duplicate send).
    const a = h.engine.processQueue();
    const b = engineB.processQueue();
    await Promise.all([a, b]);

    // Wait until all scheduled ticks finish.
    await waitTicks(5);

    expect(mockMatrix.sendEncryptedText).toHaveBeenCalledTimes(1);
  });
});

describe("SyncEngine — marks message failed after maxRetries", () => {
  let h: Harness;

  beforeEach(async () => {
    vi.clearAllMocks();
    h = makeHarness(`sync-engine-max-${Date.now()}-${Math.random()}`);
    await h.db.open();
  });

  afterEach(async () => {
    h.engine.dispose();
    await h.db.delete();
  });

  it("respects maxRetries and marks the message failed", async () => {
    mockMatrix.sendEncryptedText.mockRejectedValue(new Error("permanent"));
    await seedOp(h.db, { clientId: "op_max", maxRetries: 2 });

    h.engine.processQueue();

    await vi.waitFor(
      async () => {
        const op = await h.db.pendingOps.where("clientId").equals("op_max").first();
        expect(op?.status).toBe("failed");
      },
      { timeout: 10_000, interval: 20 },
    );

    expect(h.messageRepo.updateStatus).toHaveBeenCalledWith({ clientId: "op_max" }, "failed");
  });
});
