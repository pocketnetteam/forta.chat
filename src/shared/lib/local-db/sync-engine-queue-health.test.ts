import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Dexie from "dexie";
import "fake-indexeddb/auto";
import { SyncEngine } from "./sync-engine";
import type { PendingOperation, LocalMessage, LocalRoom } from "./schema";
import { disposeSyncEngineHarness } from "./__tests__/sync-engine-test-helpers";

class TestDb extends Dexie {
  rooms!: import("dexie").Table<LocalRoom, string>;
  messages!: import("dexie").Table<LocalMessage, number>;
  pendingOps!: import("dexie").Table<PendingOperation, number>;
  constructor() {
    super("test-sync-engine-queue-health", { indexedDB, IDBKeyRange });
    this.version(1).stores({
      rooms: "id, membership, updatedAt",
      messages: "++localId, clientId, eventId, roomId, status",
      pendingOps: "++id, status, clientId, roomId, [status+nextAttemptAt]",
    });
  }
}

vi.mock("@/entities/matrix", () => ({
  getMatrixClientService: () => ({
    isReady: () => true,
  }),
}));

// SyncEngine constructor starts a watchdog interval; we don't need it for
// these tests but we MUST dispose() to clear it or vitest hangs at exit.
function buildEngine(db: TestDb): SyncEngine {
  const messageRepo = {
    confirmSent: vi.fn(),
    getByEventId: vi.fn(),
    updateStatus: vi.fn(),
    updateReactions: vi.fn(),
    getByClientId: vi.fn(),
  };
  const roomRepo = { updateRoom: vi.fn(), syncLastMessageLocalStatus: vi.fn() };
  return new SyncEngine(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    messageRepo as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    roomRepo as any,
    async () => undefined,
  );
}

describe("SyncEngine.getQueueHealth", () => {
  let db: TestDb;
  let engine: SyncEngine | null = null;

  beforeEach(() => {
    db = new TestDb();
    engine = null;
  });

  afterEach(async () => {
    if (engine) {
      await disposeSyncEngineHarness({ engine, db });
      engine = null;
    } else {
      try {
        await db.close();
      } catch {
        // already closed
      }
      await db.delete();
    }
  });

  it("returns zero counts when the queue is empty", async () => {
    engine = buildEngine(db);
    const health = await engine.getQueueHealth();
    expect(health).toEqual({
      pendingCount: 0,
      failedCount: 0,
      syncingCount: 0,
      oldestPendingAgeMs: null,
    });
  });

  it("counts pending, failed, and syncing ops independently", async () => {
    const now = Date.now();
    await db.pendingOps.bulkAdd([
      { type: "send_message", roomId: "!r:s", payload: {}, status: "pending", retries: 0, maxRetries: 5, createdAt: now - 1000, clientId: "c1" },
      { type: "send_file", roomId: "!r:s", payload: {}, status: "syncing", retries: 0, maxRetries: 5, createdAt: now - 500, clientId: "c2" },
      { type: "send_message", roomId: "!r:s", payload: {}, status: "failed", retries: 5, maxRetries: 5, createdAt: now - 2000, errorMessage: "boom", clientId: "c3" },
      { type: "send_message", roomId: "!r:s", payload: {}, status: "failed", retries: 5, maxRetries: 5, createdAt: now - 3000, errorMessage: "boom", clientId: "c4" },
    ] as Omit<PendingOperation, "id">[]);

    engine = buildEngine(db);
    const health = await engine.getQueueHealth();
    expect(health.pendingCount).toBe(1);
    expect(health.syncingCount).toBe(1);
    expect(health.failedCount).toBe(2);
  });

  it("returns the age of the oldest pending op (not syncing/failed)", async () => {
    const now = Date.now();
    await db.pendingOps.bulkAdd([
      // Oldest is a failed op — must be ignored by oldestPendingAgeMs.
      { type: "send_message", roomId: "!r:s", payload: {}, status: "failed", retries: 5, maxRetries: 5, createdAt: now - 60_000, errorMessage: "x", clientId: "c-old-failed" },
      { type: "send_message", roomId: "!r:s", payload: {}, status: "pending", retries: 0, maxRetries: 5, createdAt: now - 10_000, clientId: "c-pending-old" },
      { type: "send_message", roomId: "!r:s", payload: {}, status: "pending", retries: 0, maxRetries: 5, createdAt: now - 1_000, clientId: "c-pending-young" },
    ] as Omit<PendingOperation, "id">[]);

    engine = buildEngine(db);
    const health = await engine.getQueueHealth();
    expect(health.pendingCount).toBe(2);
    expect(health.oldestPendingAgeMs).toBeGreaterThanOrEqual(10_000 - 250);
    expect(health.oldestPendingAgeMs).toBeLessThan(60_000); // not the failed op
  });
});
