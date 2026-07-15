import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import "fake-indexeddb/auto";
import { initChatDb, closeChatDb } from "./index";
import { ChatDatabase, type PendingOperation } from "./schema";
import { SyncEngine } from "./sync-engine";
import { disposeSyncEngineHarness } from "./__tests__/sync-engine-test-helpers";
import { MessageRepository } from "./message-repository";
import { RoomRepository } from "./room-repository";
import { SearchCacheRepository } from "./search-cache-repository";
import { DecryptionWorker } from "./decryption-worker";
import {
  signalChatsInteractive,
  __resetBootSignalsForTests,
} from "@/shared/lib/boot-signals";

// SyncEngine/DecryptionWorker construction touches the Matrix service —
// stub it the same way the other sync-engine tests do.
vi.mock("@/entities/matrix", () => ({
  getMatrixClientService: () => ({
    isReady: () => true,
    sendEncryptedText: vi.fn(() => "$evt_server"),
    sendText: vi.fn(() => "$evt_server"),
    uploadContentMxc: vi.fn(() => "mxc://s/u"),
  }),
}));

const SETTLE_MS = 1_000;
const getRoomCrypto = async () => undefined;

let userCounter = 0;

describe("initChatDb deferred recovery (WEE-97 item 1)", () => {
  let spies: {
    recoverStrandedOps: ReturnType<typeof vi.spyOn>;
    processQueue: ReturnType<typeof vi.spyOn>;
    recoverStuckMedia: ReturnType<typeof vi.spyOn>;
    cleanupCancelledUploads: ReturnType<typeof vi.spyOn>;
    recoverLatestStuckMessages: ReturnType<typeof vi.spyOn>;
    recoverOrphanedProcessing: ReturnType<typeof vi.spyOn>;
    tick: ReturnType<typeof vi.spyOn>;
    gcTombstones: ReturnType<typeof vi.spyOn>;
    gcSearchCache: ReturnType<typeof vi.spyOn>;
  };

  beforeEach(() => {
    __resetBootSignalsForTests();
    vi.useFakeTimers();
    // snapshotStrandedOpIds is awaited before processQueue/recoverStrandedOps —
    // mock it so the chain resolves in microtasks under fake timers.
    vi.spyOn(SyncEngine.prototype, "snapshotStrandedOpIds").mockResolvedValue([] as never);
    spies = {
      recoverStrandedOps: vi.spyOn(SyncEngine.prototype, "recoverStrandedOps").mockResolvedValue(undefined as never),
      processQueue: vi.spyOn(SyncEngine.prototype, "processQueue").mockResolvedValue(undefined as never),
      recoverStuckMedia: vi.spyOn(MessageRepository.prototype, "recoverStuckMedia").mockResolvedValue(0 as never),
      cleanupCancelledUploads: vi.spyOn(MessageRepository.prototype, "cleanupCancelledUploads").mockResolvedValue(0 as never),
      recoverLatestStuckMessages: vi.spyOn(DecryptionWorker.prototype, "recoverLatestStuckMessages").mockResolvedValue(0 as never),
      // WEE-93: cheap indexed reset that runs BEFORE the first tick — mocked so
      // the recoverOrphanedProcessing → tick chain resolves in microtasks
      // under fake timers (real Dexie ops don't settle here).
      recoverOrphanedProcessing: vi.spyOn(DecryptionWorker.prototype, "recoverOrphanedProcessing").mockResolvedValue(0 as never),
      tick: vi.spyOn(DecryptionWorker.prototype, "tick").mockResolvedValue(undefined as never),
      gcTombstones: vi.spyOn(RoomRepository.prototype, "garbageCollectTombstones").mockResolvedValue(0 as never),
      gcSearchCache: vi.spyOn(SearchCacheRepository.prototype, "garbageCollect").mockResolvedValue(0 as never),
    };
  });

  afterEach(() => {
    closeChatDb();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const freshUserId = () => `test-user-${++userCounter}`;

  it("starts the queue and decryption tick immediately, defers recovery scans", async () => {
    initChatDb(freshUserId(), getRoomCrypto);
    await vi.advanceTimersByTimeAsync(0);

    // Live-messaging machinery runs right away
    expect(spies.processQueue).toHaveBeenCalledTimes(1);
    // WEE-93: orphaned-"processing" reset precedes the first tick
    expect(spies.recoverOrphanedProcessing).toHaveBeenCalledTimes(1);
    expect(spies.tick).toHaveBeenCalledTimes(1);

    // Heavy table scans do NOT run before the chats-interactive signal
    expect(spies.recoverStrandedOps).not.toHaveBeenCalled();
    expect(spies.recoverStuckMedia).not.toHaveBeenCalled();
    expect(spies.cleanupCancelledUploads).not.toHaveBeenCalled();
    expect(spies.recoverLatestStuckMessages).not.toHaveBeenCalled();
    expect(spies.gcTombstones).not.toHaveBeenCalled();
    expect(spies.gcSearchCache).not.toHaveBeenCalled();
  });

  it("A2: recovery scans still run — after the signal + settle delay", async () => {
    initChatDb(freshUserId(), getRoomCrypto);

    signalChatsInteractive();
    await vi.advanceTimersByTimeAsync(SETTLE_MS);

    expect(spies.recoverStrandedOps).toHaveBeenCalledTimes(1);
    expect(spies.recoverStuckMedia).toHaveBeenCalledTimes(1);
    expect(spies.cleanupCancelledUploads).toHaveBeenCalledTimes(1);
    expect(spies.recoverLatestStuckMessages).toHaveBeenCalledTimes(1);
    expect(spies.gcTombstones).toHaveBeenCalledTimes(1);
    expect(spies.gcSearchCache).toHaveBeenCalledTimes(1);
    // recoverStrandedOps re-kicks the queue → second processQueue call
    expect(spies.processQueue).toHaveBeenCalledTimes(2);
  });

  it("A2: recovery scans run via the 30s fallback when the signal never fires", async () => {
    initChatDb(freshUserId(), getRoomCrypto);

    await vi.advanceTimersByTimeAsync(29_999);
    expect(spies.recoverStrandedOps).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1 + SETTLE_MS);
    expect(spies.recoverStrandedOps).toHaveBeenCalledTimes(1);
    expect(spies.recoverStuckMedia).toHaveBeenCalledTimes(1);
  });

  it("runDeferredRecovery is idempotent", async () => {
    const kit = initChatDb(freshUserId(), getRoomCrypto);

    kit.runDeferredRecovery?.();
    kit.runDeferredRecovery?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(spies.recoverStrandedOps).toHaveBeenCalledTimes(1);

    // The signal arriving later does not re-run the scans
    signalChatsInteractive();
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    expect(spies.recoverStrandedOps).toHaveBeenCalledTimes(1);
  });

  it("does not run recovery after the kit is disposed (logout before signal)", async () => {
    initChatDb(freshUserId(), getRoomCrypto);
    closeChatDb();

    signalChatsInteractive();
    await vi.advanceTimersByTimeAsync(SETTLE_MS);

    expect(spies.recoverStrandedOps).not.toHaveBeenCalled();
    expect(spies.recoverStuckMedia).not.toHaveBeenCalled();
  });

  it("passes the startup stranded-op snapshot to recoverStrandedOps", async () => {
    const snapshotSpy = vi
      .spyOn(SyncEngine.prototype, "snapshotStrandedOpIds")
      .mockResolvedValue([7, 42] as never);

    initChatDb(freshUserId(), getRoomCrypto);
    signalChatsInteractive();
    await vi.advanceTimersByTimeAsync(SETTLE_MS);

    expect(snapshotSpy).toHaveBeenCalledTimes(1);
    expect(spies.recoverStrandedOps).toHaveBeenCalledWith([7, 42]);
  });
});

// ---------------------------------------------------------------------------
// SyncEngine.recoverStrandedOps(onlyIds) — real-Dexie behavior (no spies)
// ---------------------------------------------------------------------------

const makeOp = (overrides: Partial<PendingOperation>): PendingOperation => ({
  type: "send_message" as PendingOperation["type"],
  roomId: "!room:server",
  payload: {},
  status: "syncing",
  retries: 1,
  maxRetries: 5,
  createdAt: Date.now(),
  clientId: `client-${Math.random().toString(36).slice(2)}`,
  ...overrides,
});

describe("SyncEngine.recoverStrandedOps with snapshot whitelist (WEE-97 H1)", () => {
  let db: ChatDatabase;
  let engine: SyncEngine;

  beforeEach(() => {
    db = new ChatDatabase(`stranded-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    engine = new SyncEngine(db, new MessageRepository(db), new RoomRepository(db), getRoomCrypto);
  });

  afterEach(async () => {
    await disposeSyncEngineHarness({ engine, db });
  });

  it("resets only snapshot ops; ops claimed after the snapshot stay untouched", async () => {
    // Stranded from a previous session — present at startup
    const strandedId = (await db.pendingOps.add(makeOp({}))) as number;

    const snapshot = await engine.snapshotStrandedOpIds();
    expect(snapshot).toEqual([strandedId]);

    // Simulate an op the live queue claimed AFTER the snapshot (mid-flight)
    const inFlightId = (await db.pendingOps.add(makeOp({ retries: 2 }))) as number;

    await engine.recoverStrandedOps(snapshot);

    const recovered = await db.pendingOps.get(strandedId);
    expect(recovered?.status).toBe("pending");
    expect(recovered?.retries).toBe(0);

    // The mid-flight op was NOT reset — no duplicate-send race
    const inFlight = await db.pendingOps.get(inFlightId);
    expect(inFlight?.status).toBe("syncing");
    expect(inFlight?.retries).toBe(2);
  });

  it("without a whitelist resets every syncing op (legacy startup ordering)", async () => {
    const a = (await db.pendingOps.add(makeOp({}))) as number;
    const b = (await db.pendingOps.add(makeOp({}))) as number;

    await engine.recoverStrandedOps();

    expect((await db.pendingOps.get(a))?.status).toBe("pending");
    expect((await db.pendingOps.get(b))?.status).toBe("pending");
  });
});
