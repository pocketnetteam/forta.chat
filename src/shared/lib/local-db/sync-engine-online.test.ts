import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Dexie from "dexie";
import "fake-indexeddb/auto";
import { SyncEngine } from "./sync-engine";
import type { PendingOperation, LocalMessage, LocalRoom } from "./schema";

// Minimal in-memory DB shape used by SyncEngine in this test.
class TestDb extends Dexie {
  rooms!: import("dexie").Table<LocalRoom, string>;
  messages!: import("dexie").Table<LocalMessage, number>;
  pendingOps!: import("dexie").Table<PendingOperation, number>;
  constructor() {
    super("test-sync-engine-online", { indexedDB, IDBKeyRange });
    this.version(1).stores({
      rooms: "id, membership, updatedAt",
      messages: "++localId, clientId, eventId, roomId, status",
      pendingOps: "++id, status, clientId, roomId",
    });
  }
}

// Stubs so the SyncEngine constructor is satisfied — we only exercise
// setOnline() side effects, not the actual processQueue() operation path.
vi.mock("@/entities/matrix", () => ({
  getMatrixClientService: () => ({
    isReady: () => true,
    sendEncryptedText: vi.fn(() => "$evt_server"),
    sendText: vi.fn(() => "$evt_server"),
    uploadContentMxc: vi.fn(() => "mxc://s/u"),
  }),
}));

describe("SyncEngine.setOnline — retryAllFailed on transition to online", () => {
  let db: TestDb;

  beforeEach(() => {
    db = new TestDb();
  });

  afterEach(async () => {
    await db.delete();
  });

  it("re-arms failed ops back to pending when the app comes online", async () => {
    // Seed two failed ops older than the transition
    await db.pendingOps.bulkAdd([
      {
        type: "send_message",
        roomId: "!r1:s",
        payload: { content: "hello" },
        status: "failed",
        retries: 5,
        maxRetries: 5,
        createdAt: Date.now() - 60_000,
        errorMessage: "network",
        clientId: "client_failed_1",
      },
      {
        type: "send_message",
        roomId: "!r1:s",
        payload: { content: "world" },
        status: "failed",
        retries: 5,
        maxRetries: 5,
        createdAt: Date.now() - 30_000,
        errorMessage: "network",
        clientId: "client_failed_2",
      },
    ] as Omit<PendingOperation, "id">[]);

    const messageRepo = {
      confirmSent: vi.fn(),
      getByEventId: vi.fn(),
      updateStatus: vi.fn(),
      updateReactions: vi.fn(),
      getByClientId: vi.fn(),
    };
    const roomRepo = {
      updateRoom: vi.fn(),
    };

    const engine = new SyncEngine(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      messageRepo as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      roomRepo as any,
      async () => undefined,
    );

    // Simulate offline → online transition
    engine.setOnline(false);
    engine.setOnline(true);

    // Allow one microtask tick for processQueue() to start and mutate
    await new Promise((r) => setTimeout(r, 0));

    const all = await db.pendingOps.toArray();
    // All previously-failed ops MUST be back to pending (or in-flight "syncing"),
    // NOT still "failed". The user should not have to tap Retry manually.
    const stillFailed = all.filter((op) => op.status === "failed");
    expect(stillFailed).toHaveLength(0);
  });
});
