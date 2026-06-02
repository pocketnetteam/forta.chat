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
