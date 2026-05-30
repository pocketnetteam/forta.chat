/**
 * Regression: SyncEngine watchdog timer must force `setOnline(true)` when:
 *   - there is at least one pending/syncing op
 *   - `this.online` is `false`
 *   - `navigator.onLine` is `true`
 *
 * Without this, Android WebView users can be stuck after a device sleep+wake
 * where `window.online` never fires: the queue holds forever until the user
 * kills and restarts the app (issues #705, #496).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Dexie from "dexie";
import "fake-indexeddb/auto";
import { SyncEngine } from "../sync-engine";
import type { PendingOperation, LocalMessage, LocalRoom } from "../schema";

// --- Matrix mock -------------------------------------------------------------

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
  uploadContent: vi.fn<
    (
      blob: Blob,
      progress?: (p: { loaded: number; total: number }) => void,
      signal?: AbortSignal,
    ) => Promise<string>
  >(async () => "https://server/_matrix/media/r0/download/server/abc"),
};

vi.mock("@/entities/matrix", () => ({
  getMatrixClientService: () => mockMatrix,
}));

// --- Test DB -----------------------------------------------------------------

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
  const roomRepo = { updateRoom: vi.fn(async () => undefined) };
  const engine = new SyncEngine(
    db as never,
    messageRepo as never,
    roomRepo as never,
    async () => undefined,
  );
  return { db, engine };
}

async function seedPendingOp(db: TestDb): Promise<void> {
  await db.pendingOps.add({
    type: "send_message",
    roomId: "!room:server",
    payload: { content: "stuck" },
    status: "pending",
    retries: 0,
    maxRetries: 5,
    createdAt: Date.now(),
    clientId: "cli_stuck_1",
    nextAttemptAt: 0,
  } as PendingOperation);
}

/**
 * Helper: flush microtasks and let fake-indexeddb's real setTimeouts settle.
 * The watchdog tick reads from IDB asynchronously, then calls setOnline(true).
 * A few short real-timer waits drain the chain without racing.
 */
async function flushAsync(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("SyncEngine — watchdog forces online when queue stuck", () => {
  let h: Harness;
  const originalOnLine = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(globalThis.navigator),
    "onLine",
  );

  beforeEach(() => {
    vi.clearAllMocks();
    // Fake ONLY setInterval/clearInterval — keep setTimeout real so
    // fake-indexeddb's internal queue and our flushAsync helper still work.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  });

  afterEach(async () => {
    h?.engine.dispose();
    await h?.db.delete();
    vi.useRealTimers();
    if (originalOnLine) {
      Object.defineProperty(globalThis.navigator, "onLine", originalOnLine);
    }
  });

  it("forces setOnline(true) when pending ops + navigator.onLine + engine.online=false", async () => {
    h = makeHarness(`watchdog-${Date.now()}-${Math.random()}`);
    await h.db.open();

    // Engine starts with online=true. Simulate the bug state: the device
    // dropped offline, no "online" event fired, but the browser-level
    // navigator.onLine actually flipped back to true after wake.
    h.engine.setOnline(false);
    await seedPendingOp(h.db);

    Object.defineProperty(globalThis.navigator, "onLine", {
      value: true,
      writable: true,
      configurable: true,
    });

    // The watchdog runs every 30s. Advance past one tick.
    await vi.advanceTimersByTimeAsync(30_000);
    await flushAsync();

    // Engine must have probed navigator.onLine and resumed.
    const onlineNow = (h.engine as unknown as { online: boolean }).online;
    expect(onlineNow).toBe(true);
  });
});
