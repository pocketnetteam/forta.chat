import type { ChatDatabase, DecryptionJob } from "./schema";

type GetRoomCrypto = (roomId: string) => Promise<{ decryptEvent(raw: unknown): Promise<{ body: string }> } | undefined>;

const BACKOFF_MS = [5_000, 30_000, 300_000, 1_800_000]; // 5s, 30s, 5min, 30min
const MAX_ATTEMPTS = 5;
const BATCH_SIZE = 20;

/**
 * Background worker that retries decryption of messages that failed
 * due to temporarily unavailable keys. Persists jobs in Dexie so
 * retries survive page reloads.
 */
export class DecryptionWorker {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private processing = false;

  constructor(
    private db: ChatDatabase,
    private getRoomCrypto: GetRoomCrypto,
  ) {}

  /** Enqueue a failed decryption for retry. Idempotent — skips if eventId already queued. */
  async enqueue(
    eventId: string,
    roomId: string,
    encryptedBody: string,
  ): Promise<void> {
    const existing = await this.db.decryptionQueue
      .where("eventId").equals(eventId).first();
    if (existing) return;

    await this.db.decryptionQueue.add({
      eventId,
      roomId,
      encryptedBody,
      status: "pending",
      attempts: 0,
      nextAttemptAt: Date.now() + BACKOFF_MS[0],
      createdAt: Date.now(),
    });

    this.scheduleNext();
  }

  /** Process all ready jobs in the queue. */
  async tick(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    try {
      const now = Date.now();
      const jobs = await this.db.decryptionQueue
        .where("[status+nextAttemptAt]")
        .between(["pending", 0], ["pending", now], true, true)
        .limit(BATCH_SIZE)
        .toArray();

      for (const job of jobs) {
        await this.processJob(job);
      }
    } finally {
      this.processing = false;
      this.scheduleNext();
    }
  }

  /** Retry all dead-letter jobs for a specific room (e.g., when new keys arrive). */
  async retryDeadForRoom(roomId: string): Promise<void> {
    await this.db.decryptionQueue
      .where("roomId").equals(roomId)
      .filter(j => j.status === "dead" || j.status === "failed")
      .modify({
        status: "pending",
        nextAttemptAt: Date.now(),
      });
    this.scheduleNext();
  }

  /** Get queue statistics for diagnostics. */
  async getStats(): Promise<{ pending: number; processing: number; dead: number }> {
    const all = await this.db.decryptionQueue.toArray();
    return {
      pending: all.filter(j => j.status === "pending").length,
      processing: all.filter(j => j.status === "processing").length,
      dead: all.filter(j => j.status === "dead").length,
    };
  }

  /** Stop the worker and clear timers. */
  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private async processJob(job: DecryptionJob): Promise<void> {
    await this.db.decryptionQueue.update(job.id!, { status: "processing" });

    try {
      const raw = JSON.parse(job.encryptedBody);
      const roomCrypto = await this.getRoomCrypto(job.roomId);
      if (!roomCrypto) throw new Error("Room crypto not available");

      const result = await roomCrypto.decryptEvent(raw);

      // Success: update message content in DB
      const msg = await this.db.messages
        .where("eventId").equals(job.eventId).first();
      if (msg) {
        await this.db.messages.update(msg.localId!, {
          content: result.body,
          decryptionStatus: "ok",
          encryptedBody: undefined,
        });
      }

      // Remove completed job
      await this.db.decryptionQueue.delete(job.id!);
    } catch (e) {
      const attempts = job.attempts + 1;
      const isDead = attempts >= MAX_ATTEMPTS;
      const backoffIndex = Math.min(attempts - 1, BACKOFF_MS.length - 1);
      const delay = BACKOFF_MS[backoffIndex];
      const jitter = Math.random() * delay * 0.2;

      await this.db.decryptionQueue.update(job.id!, {
        status: isDead ? "dead" : "pending",
        attempts,
        nextAttemptAt: isDead ? 0 : Date.now() + delay + jitter,
        lastError: String(e instanceof Error ? e.message : e),
      });

      // Also mark message as failed if dead
      if (isDead) {
        const msg = await this.db.messages
          .where("eventId").equals(job.eventId).first();
        if (msg) {
          await this.db.messages.update(msg.localId!, {
            decryptionStatus: "failed",
          });
        }
      }
    }
  }

  private scheduleNext(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    // Find next pending job
    this.db.decryptionQueue
      .where("[status+nextAttemptAt]")
      .between(["pending", 0], ["pending", Infinity], true, true)
      .first()
      .then(nextJob => {
        if (!nextJob) return;
        const delay = Math.max(0, nextJob.nextAttemptAt - Date.now());
        this.timer = setTimeout(() => this.tick(), Math.min(delay, 60_000));
      })
      .catch(() => {
        // DB error — retry in 30s
        this.timer = setTimeout(() => this.tick(), 30_000);
      });
  }
}
