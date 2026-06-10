/**
 * Regression coverage for WEE-94: per-room outbound queues in SyncEngine.
 *
 * Before the fix processTick() claimed ONE op per tick from a global FIFO —
 * a slow send (heavy encryption, slow link, retry backoff) in room A delayed
 * sends in rooms B…Z (head-of-line blocking).
 *
 * Invariants under test:
 *   A1 — a hung/retrying send in room A must not delay a send in room B;
 *   A2 — message order within one room stays strictly FIFO, including while
 *        the room's head op is waiting out a retry backoff;
 *   A3 — multi-tab: the atomic claim is preserved (no op runs twice) AND a
 *        room busy in another tab is not entered out of order;
 *   bounded parallelism — at most MAX_CONCURRENT_ROOMS rooms in flight.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Dexie from "dexie";
import "fake-indexeddb/auto";
import { SyncEngine } from "../sync-engine";
import type { PendingOperation, LocalMessage, LocalRoom } from "../schema";

// --- Matrix mock -------------------------------------------------------------

const mockMatrix = {
  sendEncryptedText: vi.fn<
    (roomId: string, content: unknown, clientId?: string) => Promise<string>
  >(async () => "$server_event_id"),
  sendText: vi.fn<(roomId: string, body: string) => Promise<string>>(
    async () => "$server_event_id",
  ),
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
    syncLastMessageLocalStatus: vi.fn(async () => undefined),
  };
  const engine = new SyncEngine(
    db as never,
    messageRepo as never,
    roomRepo as never,
    vi.fn(async () => undefined), // plain-text path
  );
  return { db, engine };
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
    nextAttemptAt: 0,
    ...overrides,
  } as PendingOperation);
}

/** Deferred promise the test can resolve/reject on demand — models a send
 *  hanging on slow encryption / slow network. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function waitTicks(n = 1): Promise<void> {
  return new Promise((resolve) => {
    let remaining = n;
    function next(): void {
      if (remaining-- <= 0) resolve();
      else setTimeout(next, 0);
    }
    next();
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SyncEngine — per-room queues (WEE-94)", () => {
  let h: Harness;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockMatrix.sendEncryptedText.mockImplementation(async () => "$server_event_id");
    h = makeHarness(`sync-engine-per-room-${Date.now()}-${Math.random()}`);
    await h.db.open();
  });

  afterEach(async () => {
    h.engine.dispose();
    await waitTicks(2); // let spawned workers observe `disposed` before db teardown
    await h.db.delete();
  });

  it("A1: a hung send in room A does not delay a send in room B", async () => {
    const hung = deferred<string>();
    mockMatrix.sendEncryptedText.mockImplementation(async (roomId: string) => {
      if (roomId === "!a:s") return hung.promise; // room A: hangs until released
      return "$ok";
    });

    await seedOp(h.db, { clientId: "op_a", roomId: "!a:s", payload: { content: "slow" } });
    await seedOp(h.db, { clientId: "op_b", roomId: "!b:s", payload: { content: "fast" } });

    h.engine.processQueue();

    // Room B completes while room A is still in flight.
    await vi.waitFor(
      async () => {
        const b = await h.db.pendingOps.where("clientId").equals("op_b").first();
        expect(b).toBeUndefined(); // delivered → op deleted
      },
      { timeout: 2000, interval: 10 },
    );
    const a = await h.db.pendingOps.where("clientId").equals("op_a").first();
    expect(a?.status).toBe("syncing"); // still in flight, not failed

    // Release room A — it must complete too.
    hung.resolve("$a_done");
    await vi.waitFor(
      async () => {
        expect(await h.db.pendingOps.count()).toBe(0);
      },
      { timeout: 2000, interval: 10 },
    );
  });

  it("A1: a retrying (backoff) op in room A does not delay room B", async () => {
    mockMatrix.sendEncryptedText.mockImplementation(async (roomId: string) => {
      if (roomId === "!a:s") throw new Error("transient network");
      return "$ok";
    });

    await seedOp(h.db, { clientId: "op_a", roomId: "!a:s" });
    await seedOp(h.db, { clientId: "op_b", roomId: "!b:s" });

    const start = Date.now();
    h.engine.processQueue();

    await vi.waitFor(
      async () => {
        const b = await h.db.pendingOps.where("clientId").equals("op_b").first();
        expect(b).toBeUndefined();
      },
      { timeout: 2000, interval: 10 },
    );
    // Min backoff is 2s — finishing under it proves B never waited for A.
    expect(Date.now() - start).toBeLessThan(2000);

    const a = await h.db.pendingOps.where("clientId").equals("op_a").first();
    expect(a?.status).toBe("pending");
    expect(a?.retries).toBe(1);
  });

  it("A2: order within one room is strictly FIFO", async () => {
    const sent: string[] = [];
    mockMatrix.sendEncryptedText.mockImplementation(
      async (_roomId: string, content: unknown) => {
        // Random per-send latency would surface order inversions if ops of
        // one room ever ran concurrently.
        await new Promise((r) => setTimeout(r, Math.random() * 10));
        sent.push((content as { body: string }).body);
        return "$ok";
      },
    );

    for (let i = 1; i <= 5; i++) {
      await seedOp(h.db, {
        clientId: `op_${i}`,
        roomId: "!same:s",
        payload: { content: `msg ${i}` },
      });
    }

    h.engine.processQueue();
    await vi.waitFor(
      async () => {
        expect(await h.db.pendingOps.count()).toBe(0);
      },
      { timeout: 3000, interval: 10 },
    );

    expect(sent).toEqual(["msg 1", "msg 2", "msg 3", "msg 4", "msg 5"]);
  });

  it("A2: a later message must NOT overtake a retrying head in the same room", async () => {
    let firstAttempts = 0;
    mockMatrix.sendEncryptedText.mockImplementation(
      async (_roomId: string, content: unknown) => {
        const body = (content as { body: string }).body;
        if (body === "first" && ++firstAttempts === 1) {
          throw new Error("transient");
        }
        return "$ok";
      },
    );

    const firstId = await seedOp(h.db, {
      clientId: "op_first",
      roomId: "!same:s",
      payload: { content: "first" },
    });
    await seedOp(h.db, {
      clientId: "op_second",
      roomId: "!same:s",
      payload: { content: "second" },
    });

    h.engine.processQueue();

    // Head fails and enters backoff…
    await vi.waitFor(
      async () => {
        const first = await h.db.pendingOps.where("clientId").equals("op_first").first();
        expect(first?.retries).toBe(1);
      },
      { timeout: 1000, interval: 10 },
    );
    await waitTicks(4);

    // …and the second op of the SAME room must still be untouched: one send
    // attempt total (the failed head), second op still pending.
    expect(mockMatrix.sendEncryptedText).toHaveBeenCalledTimes(1);
    const second = await h.db.pendingOps.where("clientId").equals("op_second").first();
    expect(second?.status).toBe("pending");

    // Fast-forward the backoff; both flush in order.
    await h.db.pendingOps.update(firstId, { nextAttemptAt: 0 });
    h.engine.processQueue();
    await vi.waitFor(
      async () => {
        expect(await h.db.pendingOps.count()).toBe(0);
      },
      { timeout: 2000, interval: 10 },
    );
    const bodies = mockMatrix.sendEncryptedText.mock.calls.map(
      (c) => (c[1] as { body: string }).body,
    );
    expect(bodies).toEqual(["first", "first", "second"]);
  });

  it("A3: multi-tab — same op never executes twice, same room never runs concurrently", async () => {
    const inFlightByRoom = new Map<string, number>();
    let maxSameRoomConcurrency = 0;
    mockMatrix.sendEncryptedText.mockImplementation(
      async (roomId: string, content: unknown) => {
        const current = (inFlightByRoom.get(roomId) ?? 0) + 1;
        inFlightByRoom.set(roomId, current);
        maxSameRoomConcurrency = Math.max(maxSameRoomConcurrency, current);
        await new Promise((r) => setTimeout(r, 20));
        inFlightByRoom.set(roomId, current - 1);
        return `$ok_${(content as { body: string }).body}`;
      },
    );

    // Second engine instance on the SAME db (simulates multi-tab browser).
    const db2 = h.db;
    const engineB = new SyncEngine(
      db2 as never,
      {
        confirmSent: vi.fn(async () => undefined),
        updateStatus: vi.fn(async () => undefined),
        getByEventId: vi.fn(async () => undefined),
        updateReactions: vi.fn(async () => undefined),
        getByClientId: vi.fn(async () => undefined),
      } as never,
      {
        updateRoom: vi.fn(async () => undefined),
        syncLastMessageLocalStatus: vi.fn(async () => undefined),
      } as never,
      vi.fn(async () => undefined) as never,
    );

    await seedOp(h.db, { clientId: "op_1", roomId: "!same:s", payload: { content: "one" } });
    await seedOp(h.db, { clientId: "op_2", roomId: "!same:s", payload: { content: "two" } });

    h.engine.processQueue();
    engineB.processQueue();

    await vi.waitFor(
      async () => {
        expect(await h.db.pendingOps.count()).toBe(0);
      },
      { timeout: 3000, interval: 10 },
    );
    await waitTicks(3);

    // Exactly two sends — one per op (no duplicate execution)…
    expect(mockMatrix.sendEncryptedText).toHaveBeenCalledTimes(2);
    // …and never two ops of the same room in flight at once (FIFO held).
    expect(maxSameRoomConcurrency).toBe(1);
    const bodies = mockMatrix.sendEncryptedText.mock.calls.map(
      (c) => (c[1] as { body: string }).body,
    );
    expect(bodies).toEqual(["one", "two"]);

    engineB.dispose();
  });

  it("pull-forward: a fresh send enqueued during a backoff wake is not delayed by it", async () => {
    mockMatrix.sendEncryptedText.mockImplementation(async (roomId: string) => {
      if (roomId === "!a:s") throw new Error("transient");
      return "$ok";
    });

    // Room A fails and schedules a ~2-3s backoff wake (the only timer).
    await seedOp(h.db, { clientId: "op_a", roomId: "!a:s" });
    h.engine.processQueue();
    await vi.waitFor(
      async () => {
        const a = await h.db.pendingOps.where("clientId").equals("op_a").first();
        expect(a?.retries).toBe(1);
      },
      { timeout: 1000, interval: 10 },
    );
    await waitTicks(2); // let the wake timer get armed

    // A fresh send in room B arrives while only the far-future wake exists.
    // Before the scheduledAt pull-forward it waited out the backoff timer
    // (or the 30s watchdog); now it must go out immediately.
    const start = Date.now();
    await seedOp(h.db, { clientId: "op_b", roomId: "!b:s" });
    h.engine.processQueue();

    await vi.waitFor(
      async () => {
        const b = await h.db.pendingOps.where("clientId").equals("op_b").first();
        expect(b).toBeUndefined();
      },
      { timeout: 1500, interval: 10 },
    );
    expect(Date.now() - start).toBeLessThan(1500); // min backoff is 2s
  });

  it("runs at most MAX_CONCURRENT_ROOMS (3) rooms in parallel", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const gates: Array<() => void> = [];
    mockMatrix.sendEncryptedText.mockImplementation(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise<void>((r) => gates.push(r));
      inFlight--;
      return "$ok";
    });

    for (let i = 1; i <= 5; i++) {
      await seedOp(h.db, { clientId: `op_${i}`, roomId: `!r${i}:s` });
    }

    h.engine.processQueue();

    // The pool fills to exactly 3 and holds there while sends are gated.
    await vi.waitFor(() => expect(inFlight).toBe(3), { timeout: 2000, interval: 10 });
    await waitTicks(4);
    expect(maxInFlight).toBe(3);

    // Releasing sends lets the remaining rooms cycle through the pool.
    const releaseAll = setInterval(() => {
      gates.splice(0).forEach((release) => release());
    }, 10);
    try {
      await vi.waitFor(
        async () => {
          expect(await h.db.pendingOps.count()).toBe(0);
        },
        { timeout: 3000, interval: 10 },
      );
    } finally {
      clearInterval(releaseAll);
    }
    expect(maxInFlight).toBe(3);
  });
});

describe("SyncEngine — watchdog releases expired 'syncing' claims (WEE-94)", () => {
  let h: Harness;

  beforeEach(() => {
    vi.clearAllMocks();
    mockMatrix.sendEncryptedText.mockImplementation(async () => "$server_event_id");
    // Fake ONLY setInterval/clearInterval — keep setTimeout real so
    // fake-indexeddb's internal queue and vi.waitFor still work.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  });

  afterEach(async () => {
    h?.engine.dispose();
    vi.useRealTimers();
    await waitTicks(2);
    await h?.db.delete();
  });

  it("an expired claim (crashed tab) unblocks its room on the next watchdog tick", async () => {
    h = makeHarness(`sync-engine-lease-${Date.now()}-${Math.random()}`);
    await h.db.open();

    // A "syncing" row stranded by a crashed sibling tab 7 minutes ago…
    await seedOp(h.db, {
      clientId: "op_stuck",
      roomId: "!x:s",
      status: "syncing",
      lastAttemptAt: Date.now() - 7 * 60_000,
    });
    // …and a newer pending op of the SAME room, blocked behind it.
    await seedOp(h.db, { clientId: "op_blocked", roomId: "!x:s" });

    // The room is busy from the engine's point of view — nothing is claimable.
    h.engine.processQueue();
    await waitTicks(4);
    expect(mockMatrix.sendEncryptedText).not.toHaveBeenCalled();
    expect(
      (await h.db.pendingOps.where("clientId").equals("op_blocked").first())?.status,
    ).toBe("pending");

    // Watchdog tick (30s): the expired lease is released and the room drains
    // in FIFO order — the formerly-stuck head first, then the blocked op.
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(
      async () => {
        expect(await h.db.pendingOps.count()).toBe(0);
      },
      { timeout: 3000, interval: 10 },
    );
    const order = mockMatrix.sendEncryptedText.mock.calls.map(
      (c) => (c[1] as { body: string }).body,
    );
    expect(order).toEqual(["hello", "hello"]); // both default payloads, 2 sends
    expect(mockMatrix.sendEncryptedText).toHaveBeenCalledTimes(2);
  });
});
