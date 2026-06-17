import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Dexie from "dexie";
import "fake-indexeddb/auto";
import { DecryptionWorker } from "../decryption-worker";
import type { DecryptionJob } from "../schema";

// Minimal in-memory Dexie for tests
class TestDb extends Dexie {
  decryptionQueue!: Dexie.Table<DecryptionJob>;
  messages!: Dexie.Table<any>;
  rooms!: Dexie.Table<any>;

  constructor(name = "test-decrypt") {
    super(name, { indexedDB, IDBKeyRange });
    this.version(1).stores({
      decryptionQueue: "++id, eventId, roomId, status, [status+nextAttemptAt]",
      messages: "++localId, eventId, [roomId+timestamp]",
      rooms: "id",
    });
  }
}

function makeWorker(
  db: TestDb,
  decryptFn: (raw: unknown) => Promise<{ body: string }> = async () => ({ body: "decrypted" }),
) {
  const getRoomCrypto = vi.fn().mockResolvedValue({ decryptEvent: decryptFn });
  const worker = new DecryptionWorker(db as any, getRoomCrypto);
  return { worker, getRoomCrypto };
}

describe("DecryptionWorker", () => {
  let db: TestDb;

  beforeEach(async () => {
    db = new TestDb(`test-decrypt-${Date.now()}-${Math.random()}`);
    await db.open();
  });

  afterEach(async () => {
    await db.delete();
  });

  it("enqueue creates a job with status 'queued'", async () => {
    const { worker } = makeWorker(db);
    await worker.enqueue("$ev1", "!room1", '{"type":"m.room.message"}');
    const jobs = await db.decryptionQueue.toArray();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].status).toBe("queued");
    expect(jobs[0].attempts).toBe(0);
    worker.dispose();
  });

  it("enqueue is idempotent — same eventId skipped", async () => {
    const { worker } = makeWorker(db);
    await worker.enqueue("$ev1", "!room1", '{}');
    await worker.enqueue("$ev1", "!room1", '{}');
    const jobs = await db.decryptionQueue.toArray();
    expect(jobs).toHaveLength(1);
    worker.dispose();
  });

  it("tick processes ready jobs and deletes on success", async () => {
    const { worker } = makeWorker(db);
    await db.messages.add({ eventId: "$ev1", roomId: "!room1", content: "[encrypted]", decryptionStatus: "pending" } as any);
    await worker.enqueue("$ev1", "!room1", '{"type":"m.room.message"}');
    await db.decryptionQueue.toCollection().modify({ nextAttemptAt: 0 });
    await worker.tick();

    const jobs = await db.decryptionQueue.toArray();
    expect(jobs).toHaveLength(0);

    const msg = await db.messages.where("eventId").equals("$ev1").first();
    expect(msg?.content).toBe("decrypted");
    expect(msg?.decryptionStatus).toBe("ok");
    worker.dispose();
  });

  it("failure moves job to 'waiting' with backoff", async () => {
    const failCrypto = vi.fn().mockRejectedValue(new Error("no key"));
    const { worker } = makeWorker(db, failCrypto);
    await worker.enqueue("$ev1", "!room1", '{}');
    await db.decryptionQueue.toCollection().modify({ nextAttemptAt: 0 });
    await worker.tick();

    const job = await db.decryptionQueue.where("eventId").equals("$ev1").first();
    expect(job?.status).toBe("waiting");
    expect(job?.attempts).toBe(1);
    expect(job?.nextAttemptAt).toBeGreaterThan(Date.now() - 1000);
    worker.dispose();
  });

  it("job becomes dead after MAX_ATTEMPTS (8)", async () => {
    const failCrypto = vi.fn().mockRejectedValue(new Error("no key"));
    const { worker } = makeWorker(db, failCrypto);
    await worker.enqueue("$ev1", "!room1", '{}');
    await db.decryptionQueue.toCollection().modify({ attempts: 7, nextAttemptAt: 0 });
    await worker.tick();

    const job = await db.decryptionQueue.where("eventId").equals("$ev1").first();
    expect(job?.status).toBe("dead");
    expect(job?.attempts).toBe(8);
    worker.dispose();
  });

  it("retryForRoom resets dead jobs to queued with attempts=0", async () => {
    const { worker } = makeWorker(db);
    await db.decryptionQueue.add({
      eventId: "$ev1", roomId: "!room1", encryptedBody: '{}',
      status: "dead", attempts: 8, nextAttemptAt: 0, createdAt: Date.now(),
    });
    await worker.retryForRoom("!room1");

    const job = await db.decryptionQueue.where("eventId").equals("$ev1").first();
    expect(job?.status).toBe("queued");
    expect(job?.attempts).toBe(0);
    expect(job?.nextAttemptAt).toBeLessThanOrEqual(Date.now());
    worker.dispose();
  });

  it("retryAllWaiting sets nextAttemptAt=now for queued/waiting", async () => {
    const { worker } = makeWorker(db);
    const future = Date.now() + 999_999;
    await db.decryptionQueue.bulkAdd([
      { eventId: "$ev1", roomId: "!r1", encryptedBody: '{}', status: "queued", attempts: 1, nextAttemptAt: future, createdAt: Date.now() },
      { eventId: "$ev2", roomId: "!r1", encryptedBody: '{}', status: "waiting", attempts: 3, nextAttemptAt: future, createdAt: Date.now() },
      { eventId: "$ev3", roomId: "!r1", encryptedBody: '{}', status: "dead", attempts: 8, nextAttemptAt: 0, createdAt: Date.now() },
    ]);
    await worker.retryAllWaiting();

    const jobs = await db.decryptionQueue.orderBy("eventId").toArray();
    expect(jobs[0].nextAttemptAt).toBeLessThanOrEqual(Date.now());
    expect(jobs[1].nextAttemptAt).toBeLessThanOrEqual(Date.now());
    expect(jobs[2].nextAttemptAt).toBe(0);
    worker.dispose();
  });

  it("fast backoff for first 3 attempts, slow after", async () => {
    const failCrypto = vi.fn().mockRejectedValue(new Error("no key"));
    const { worker } = makeWorker(db, failCrypto);
    await worker.enqueue("$ev1", "!room1", '{}');

    await db.decryptionQueue.toCollection().modify({ nextAttemptAt: 0 });
    const before1 = Date.now();
    await worker.tick();
    const job1 = await db.decryptionQueue.where("eventId").equals("$ev1").first();
    const delay1 = job1!.nextAttemptAt - before1;
    expect(delay1).toBeGreaterThanOrEqual(1600);
    expect(delay1).toBeLessThanOrEqual(2400);

    await db.decryptionQueue.toCollection().modify({ attempts: 3, nextAttemptAt: 0, status: "queued" });
    const before4 = Date.now();
    await worker.tick();
    const job4 = await db.decryptionQueue.where("eventId").equals("$ev1").first();
    const delay4 = job4!.nextAttemptAt - before4;
    expect(delay4).toBeGreaterThanOrEqual(24_000);
    expect(delay4).toBeLessThanOrEqual(36_000);

    worker.dispose();
  });

  it("getStats returns correct counts", async () => {
    const { worker } = makeWorker(db);
    await db.decryptionQueue.bulkAdd([
      { eventId: "$1", roomId: "!r", encryptedBody: '{}', status: "queued", attempts: 0, nextAttemptAt: 0, createdAt: Date.now() },
      { eventId: "$2", roomId: "!r", encryptedBody: '{}', status: "waiting", attempts: 2, nextAttemptAt: 0, createdAt: Date.now() },
      { eventId: "$3", roomId: "!r", encryptedBody: '{}', status: "dead", attempts: 8, nextAttemptAt: 0, createdAt: Date.now() - 60_000 },
    ]);
    const stats = await worker.getStats();
    expect(stats.queued).toBe(1);
    expect(stats.waiting).toBe(1);
    expect(stats.dead).toBe(1);
    expect(stats.oldestDeadAge).toBeGreaterThanOrEqual(59_000);
    worker.dispose();
  });

  // ── WEE-35: recover persisted "[encrypted]" messages (e.g. 502 key-outage) ──
  describe("recoverStuckMessages", () => {
    it("re-queues a persisted pending message that has no queue job", async () => {
      const { worker } = makeWorker(db);
      await db.messages.add({
        eventId: "$ev1", roomId: "!room1", timestamp: 1000,
        content: "[encrypted]", decryptionStatus: "pending",
        encryptedBody: '{"type":"m.room.message"}',
      } as any);

      const count = await worker.recoverStuckMessages("!room1");
      expect(count).toBe(1);
      const job = await db.decryptionQueue.where("eventId").equals("$ev1").first();
      expect(job?.status).toBe("queued");
      expect(job?.attempts).toBe(0);
      worker.dispose();
    });

    it("resets an existing dead job for a stuck message back to queued", async () => {
      const { worker } = makeWorker(db);
      await db.messages.add({
        eventId: "$ev1", roomId: "!room1", timestamp: 1000,
        content: "[encrypted]", decryptionStatus: "failed",
        encryptedBody: '{"v":1}',
      } as any);
      await db.decryptionQueue.add({
        eventId: "$ev1", roomId: "!room1", encryptedBody: '{"stale":true}',
        status: "dead", attempts: 8, nextAttemptAt: 0, createdAt: Date.now(),
      });

      const count = await worker.recoverStuckMessages("!room1");
      expect(count).toBe(1);
      const job = await db.decryptionQueue.where("eventId").equals("$ev1").first();
      expect(job?.status).toBe("queued");
      expect(job?.attempts).toBe(0);
      // Ciphertext refreshed from the authoritative message row.
      expect(job?.encryptedBody).toBe('{"v":1}');
      worker.dispose();
    });

    it("ignores messages without ciphertext or already decrypted", async () => {
      const { worker } = makeWorker(db);
      await db.messages.bulkAdd([
        { eventId: "$noBody", roomId: "!room1", timestamp: 1, content: "[encrypted]", decryptionStatus: "pending" },
        { eventId: "$ok", roomId: "!room1", timestamp: 2, content: "hi", decryptionStatus: "ok", encryptedBody: '{}' },
      ] as any);

      const count = await worker.recoverStuckMessages("!room1");
      expect(count).toBe(0);
      expect(await db.decryptionQueue.count()).toBe(0);
      worker.dispose();
    });

    it("does not disturb a job that is currently processing", async () => {
      const { worker } = makeWorker(db);
      await db.messages.add({
        eventId: "$ev1", roomId: "!room1", timestamp: 1,
        content: "[encrypted]", decryptionStatus: "pending", encryptedBody: '{}',
      } as any);
      await db.decryptionQueue.add({
        eventId: "$ev1", roomId: "!room1", encryptedBody: '{}',
        status: "processing", attempts: 1, nextAttemptAt: 0, createdAt: Date.now(),
      });

      const count = await worker.recoverStuckMessages("!room1");
      expect(count).toBe(0);
      const job = await db.decryptionQueue.where("eventId").equals("$ev1").first();
      expect(job?.status).toBe("processing");
      worker.dispose();
    });

    it("recovered message gets decrypted on the next tick", async () => {
      const { worker } = makeWorker(db);
      await db.messages.add({
        eventId: "$ev1", roomId: "!room1", timestamp: 1,
        content: "[encrypted]", decryptionStatus: "pending",
        encryptedBody: '{"type":"m.room.message"}',
      } as any);

      await worker.recoverStuckMessages("!room1");
      await db.decryptionQueue.toCollection().modify({ nextAttemptAt: 0 });
      await worker.tick();

      const msg = await db.messages.where("eventId").equals("$ev1").first();
      expect(msg?.content).toBe("decrypted");
      expect(msg?.decryptionStatus).toBe("ok");
      worker.dispose();
    });
  });

  describe("decryptMessageNow", () => {
    it("decrypts a single message immediately and writes the plaintext back", async () => {
      const { worker } = makeWorker(db, async () => ({ body: "hello" }));
      await db.messages.add({
        eventId: "$ev1", roomId: "!room1", timestamp: 1,
        content: "[encrypted]", decryptionStatus: "pending",
        encryptedBody: '{"type":"m.room.message"}',
      } as any);

      const ok = await worker.decryptMessageNow("$ev1");
      expect(ok).toBe(true);
      const msg = await db.messages.where("eventId").equals("$ev1").first();
      expect(msg?.content).toBe("hello");
      expect(msg?.decryptionStatus).toBe("ok");
      expect(msg?.encryptedBody).toBeUndefined();
      worker.dispose();
    });

    it("returns false when there is no ciphertext to decrypt", async () => {
      const { worker } = makeWorker(db);
      await db.messages.add({
        eventId: "$ev1", roomId: "!room1", timestamp: 1,
        content: "[encrypted]", decryptionStatus: "pending",
      } as any);
      expect(await worker.decryptMessageNow("$ev1")).toBe(false);
      worker.dispose();
    });

    it("returns false (leaves row intact) when decryption fails", async () => {
      const { worker } = makeWorker(db, async () => { throw new Error("no key"); });
      await db.messages.add({
        eventId: "$ev1", roomId: "!room1", timestamp: 1,
        content: "[encrypted]", decryptionStatus: "pending", encryptedBody: '{}',
      } as any);
      expect(await worker.decryptMessageNow("$ev1")).toBe(false);
      const msg = await db.messages.where("eventId").equals("$ev1").first();
      expect(msg?.content).toBe("[encrypted]");
      expect(msg?.decryptionStatus).toBe("pending");
      worker.dispose();
    });
  });

  describe("recoverAllStuckMessages", () => {
    it("re-queues only PENDING messages across rooms; skips failed/soft-deleted/ok", async () => {
      const { worker } = makeWorker(db);
      await db.messages.bulkAdd([
        { eventId: "$a", roomId: "!r1", timestamp: 1, content: "[encrypted]", decryptionStatus: "pending", encryptedBody: '{}' },
        { eventId: "$pendingR2", roomId: "!r2", timestamp: 1, content: "[encrypted]", decryptionStatus: "pending", encryptedBody: '{}' },
        // "failed" is terminal — boot sweep must NOT resurrect it (only room-open/keys-loaded does)
        { eventId: "$failed", roomId: "!r2", timestamp: 2, content: "[encrypted]", decryptionStatus: "failed", encryptedBody: '{}' },
        { eventId: "$deleted", roomId: "!r2", timestamp: 3, content: "[encrypted]", decryptionStatus: "pending", encryptedBody: '{}', softDeleted: true },
        { eventId: "$ok", roomId: "!r2", timestamp: 4, content: "ok", decryptionStatus: "ok" },
      ] as any);

      const count = await worker.recoverAllStuckMessages();
      expect(count).toBe(2);
      const queued = await db.decryptionQueue.where("status").equals("queued").toArray();
      expect(queued.map((j) => j.eventId).sort()).toEqual(["$a", "$pendingR2"]);
      worker.dispose();
    });
  });

  // ── WEE-93: tick commits all results in a single transaction ──
  describe("batched tick commits", () => {
    it("decrypts N jobs and commits all results in one explicit transaction", async () => {
      const { worker } = makeWorker(db, async (raw: any) => ({ body: `dec-${raw.n}` }));
      await db.messages.bulkAdd([
        { eventId: "$e1", roomId: "!r1", timestamp: 1, content: "[encrypted]", decryptionStatus: "pending" },
        { eventId: "$e2", roomId: "!r1", timestamp: 2, content: "[encrypted]", decryptionStatus: "pending" },
        { eventId: "$e3", roomId: "!r2", timestamp: 3, content: "[encrypted]", decryptionStatus: "pending" },
      ] as any);
      await db.decryptionQueue.bulkAdd([
        { eventId: "$e1", roomId: "!r1", encryptedBody: '{"n":1}', status: "queued", attempts: 0, nextAttemptAt: 0, createdAt: Date.now() },
        { eventId: "$e2", roomId: "!r1", encryptedBody: '{"n":2}', status: "queued", attempts: 0, nextAttemptAt: 0, createdAt: Date.now() },
        { eventId: "$e3", roomId: "!r2", encryptedBody: '{"n":3}', status: "queued", attempts: 0, nextAttemptAt: 0, createdAt: Date.now() },
      ]);

      const txSpy = vi.spyOn(db, "transaction");
      await worker.tick();

      // One pick + one commit transaction for the whole tick (not one per job)
      expect(txSpy).toHaveBeenCalledTimes(2);
      expect(await db.decryptionQueue.count()).toBe(0);
      const m1 = await db.messages.where("eventId").equals("$e1").first();
      const m2 = await db.messages.where("eventId").equals("$e2").first();
      const m3 = await db.messages.where("eventId").equals("$e3").first();
      expect(m1?.content).toBe("dec-1");
      expect(m2?.content).toBe("dec-2");
      expect(m3?.content).toBe("dec-3");
      expect(m1?.decryptionStatus).toBe("ok");
      worker.dispose();
    });

    it("mixed batch: failures back off while successes commit", async () => {
      const decryptFn = vi.fn().mockImplementation(async (raw: any) => {
        if (raw.fail) throw new Error("no key");
        return { body: "plain" };
      });
      const { worker } = makeWorker(db, decryptFn);
      await db.messages.bulkAdd([
        { eventId: "$ok", roomId: "!r1", timestamp: 1, content: "[encrypted]", decryptionStatus: "pending" },
        { eventId: "$bad", roomId: "!r1", timestamp: 2, content: "[encrypted]", decryptionStatus: "pending" },
      ] as any);
      await db.decryptionQueue.bulkAdd([
        { eventId: "$ok", roomId: "!r1", encryptedBody: '{}', status: "queued", attempts: 0, nextAttemptAt: 0, createdAt: Date.now() },
        { eventId: "$bad", roomId: "!r1", encryptedBody: '{"fail":true}', status: "queued", attempts: 0, nextAttemptAt: 0, createdAt: Date.now() },
      ]);

      await worker.tick();

      const okMsg = await db.messages.where("eventId").equals("$ok").first();
      expect(okMsg?.content).toBe("plain");
      expect(await db.decryptionQueue.where("eventId").equals("$ok").count()).toBe(0);

      const badJob = await db.decryptionQueue.where("eventId").equals("$bad").first();
      expect(badJob?.status).toBe("waiting");
      expect(badJob?.attempts).toBe(1);
      const badMsg = await db.messages.where("eventId").equals("$bad").first();
      expect(badMsg?.content).toBe("[encrypted]");
      worker.dispose();
    });

    it("tick with no ready jobs performs no commit transaction", async () => {
      const { worker } = makeWorker(db);
      const txSpy = vi.spyOn(db, "transaction");
      await worker.tick();
      // Only the pick transaction runs; no commit transaction
      expect(txSpy.mock.calls.length).toBeLessThanOrEqual(1);
      expect(await db.decryptionQueue.count()).toBe(0);
      worker.dispose();
    });

    it("does NOT delete the job when the message row is not persisted yet", async () => {
      // Message still sitting in the EventWriter write buffer → decrypt
      // succeeds but there is no row to write to. The job must back off,
      // not be deleted (deleting would strand the message as [encrypted]).
      const { worker } = makeWorker(db, async () => ({ body: "plain" }));
      await db.decryptionQueue.add({
        eventId: "$notYet", roomId: "!r1", encryptedBody: '{}',
        status: "queued", attempts: 0, nextAttemptAt: 0, createdAt: Date.now(),
      });

      await worker.tick();

      const job = await db.decryptionQueue.where("eventId").equals("$notYet").first();
      expect(job).toBeTruthy();
      expect(job?.status).toBe("waiting");
      expect(job?.attempts).toBe(1);
      worker.dispose();
    });
  });

  // ── WEE-93: jobs stranded in "processing" by a crashed session ──
  describe("recoverOrphanedProcessing", () => {
    it("re-queues processing jobs left over from a dead session", async () => {
      const { worker } = makeWorker(db);
      await db.decryptionQueue.bulkAdd([
        { eventId: "$p1", roomId: "!r1", encryptedBody: '{}', status: "processing", attempts: 2, nextAttemptAt: 0, createdAt: Date.now() },
        { eventId: "$p2", roomId: "!r1", encryptedBody: '{}', status: "processing", attempts: 0, nextAttemptAt: 0, createdAt: Date.now() },
        { eventId: "$q1", roomId: "!r1", encryptedBody: '{}', status: "waiting", attempts: 1, nextAttemptAt: 99, createdAt: Date.now() },
      ]);

      const count = await worker.recoverOrphanedProcessing();
      expect(count).toBe(2);

      const jobs = await db.decryptionQueue.orderBy("eventId").toArray();
      const p1 = jobs.find(j => j.eventId === "$p1");
      const p2 = jobs.find(j => j.eventId === "$p2");
      const q1 = jobs.find(j => j.eventId === "$q1");
      expect(p1?.status).toBe("queued");
      expect(p2?.status).toBe("queued");
      expect(q1?.status).toBe("waiting"); // untouched
      worker.dispose();
    });

    it("recovered jobs get decrypted on the next tick", async () => {
      const { worker } = makeWorker(db);
      await db.messages.add({ eventId: "$p1", roomId: "!r1", timestamp: 1, content: "[encrypted]", decryptionStatus: "pending" } as any);
      await db.decryptionQueue.add({
        eventId: "$p1", roomId: "!r1", encryptedBody: '{"type":"m.room.message"}',
        status: "processing", attempts: 0, nextAttemptAt: 0, createdAt: Date.now(),
      });

      await worker.recoverOrphanedProcessing();
      await db.decryptionQueue.toCollection().modify({ nextAttemptAt: 0 });
      await worker.tick();

      const msg = await db.messages.where("eventId").equals("$p1").first();
      expect(msg?.content).toBe("decrypted");
      expect(await db.decryptionQueue.count()).toBe(0);
      worker.dispose();
    });
  });

  it("full flow: enqueue → fail → retryForRoom → succeed", async () => {
    let shouldFail = true;
    const conditionalCrypto = vi.fn().mockImplementation(async () => {
      if (shouldFail) throw new Error("no key yet");
      return { body: "hello world" };
    });
    const { worker } = makeWorker(db, conditionalCrypto);

    await db.messages.add({ eventId: "$ev1", roomId: "!room1", content: "[encrypted]", decryptionStatus: "pending" } as any);
    await worker.enqueue("$ev1", "!room1", '{"type":"m.room.message"}');
    await db.decryptionQueue.toCollection().modify({ nextAttemptAt: 0 });
    await worker.tick();

    let job = await db.decryptionQueue.where("eventId").equals("$ev1").first();
    expect(job?.status).toBe("waiting");

    shouldFail = false;
    await worker.retryForRoom("!room1");

    job = await db.decryptionQueue.where("eventId").equals("$ev1").first();
    expect(job?.status).toBe("queued");
    expect(job?.attempts).toBe(0);

    await worker.tick();

    const jobs = await db.decryptionQueue.toArray();
    expect(jobs).toHaveLength(0);

    const msg = await db.messages.where("eventId").equals("$ev1").first();
    expect(msg?.content).toBe("hello world");
    expect(msg?.decryptionStatus).toBe("ok");

    worker.dispose();
  });
});
