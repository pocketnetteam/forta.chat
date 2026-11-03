/**
 * The retry timer fires at whole milliseconds while nextAttemptAt carries the
 * fraction of its jittered backoff. When the clock ticked between the claim
 * ("not due yet") and the wake-up lookup ("not in the future any more"), the
 * op was neither claimed nor woken for, and its retry waited for the 30 s
 * watchdog (seen as a 1-in-18 timeout of the W2C-05 retry test, 2026-10-10).
 * The claim and both wake-up lookups now share one clock reading.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import Dexie from "dexie";
import "fake-indexeddb/auto";
import { SyncEngine, STUCK_UPLOAD_MS } from "../sync-engine";
import type { PendingOperation, LocalMessage, LocalRoom } from "../schema";
import { disposeSyncEngineHarness } from "./sync-engine-test-helpers";

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
  const roomRepo = { updateRoom: vi.fn(async () => undefined), syncLastMessageLocalStatus: vi.fn(async () => undefined) };
  const engine = new SyncEngine(
    db as never,
    messageRepo as never,
    roomRepo as never,
    async () => undefined,
  );
  return { db, engine };
}

/** Date.now() as seen from inside `lookup`: one millisecond later than elsewhere. */
function clockTicksDuring(lookup: string, at: number): void {
  vi.spyOn(Date, "now").mockImplementation(() => ((new Error().stack ?? "").includes(lookup) ? at + 1 : at));
}

type EngineInternals = { processTick(): Promise<void>; scheduled: boolean };

describe("SyncEngine wake-up across a clock tick", () => {
  let h: Harness | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    if (h) await disposeSyncEngineHarness(h);
    h = undefined;
  });

  it("wakes for a retry that falls due between the claim and the wake-up lookup", async () => {
    h = makeHarness(`sync-engine-wake-${Date.now()}-${Math.random()}`);
    await h.db.open();
    const T = Date.now() + 60_000;
    await h.db.pendingOps.add({
      type: "send_message", roomId: "!room:server", payload: { content: "retry" }, status: "pending",
      retries: 1, maxRetries: 5, createdAt: T - 5_000, clientId: "cli_retry", nextAttemptAt: T + 0.5,
    } as PendingOperation);

    clockTicksDuring("findNextRetryDelay", T);
    await (h.engine as unknown as EngineInternals).processTick();

    expect((h.engine as unknown as EngineInternals).scheduled).toBe(true);
  });

  it("wakes for text that may pass an upload turning stuck between the claim and the lookup", async () => {
    h = makeHarness(`sync-engine-wake-stuck-${Date.now()}-${Math.random()}`);
    await h.db.open();
    const T = Date.now() + 60_000;
    // The upload runs in another tab: a "syncing" row this engine does not own.
    await h.db.pendingOps.add({
      type: "send_file", roomId: "!room:server", payload: {}, status: "syncing", retries: 0, maxRetries: 5,
      createdAt: T - STUCK_UPLOAD_MS, clientId: "cli_file", nextAttemptAt: 0, lastAttemptAt: T - STUCK_UPLOAD_MS + 0.5,
    } as PendingOperation);
    await h.db.pendingOps.add({
      type: "send_message", roomId: "!room:server", payload: { content: "after" }, status: "pending", retries: 0,
      maxRetries: 5, createdAt: T - 1_000, clientId: "cli_text", nextAttemptAt: 0,
    } as PendingOperation);

    clockTicksDuring("findNextStuckUploadDelay", T);
    await (h.engine as unknown as EngineInternals).processTick();

    expect((h.engine as unknown as EngineInternals).scheduled).toBe(true);
  });
});
