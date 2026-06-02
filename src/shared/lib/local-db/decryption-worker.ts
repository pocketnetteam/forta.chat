import type { ChatDatabase, DecryptionJob } from "./schema";
import type { RoomRepository } from "./room-repository";
import { MessageType } from "@/entities/chat/model/types";
import { cryptoDebug } from "@/shared/lib/utils/crypto-debug";

type GetRoomCrypto = (roomId: string) => Promise<{ decryptEvent(raw: unknown): Promise<{ body: string }> } | undefined>;

const FAST_BACKOFF_MS = [2_000, 5_000, 10_000];
const SLOW_BACKOFF_MS = [30_000, 120_000, 600_000, 3_600_000];
const MAX_ATTEMPTS = 8;
const BATCH_SIZE = 20;

/**
 * Background worker that retries decryption of messages with temporarily
 * unavailable keys. Persists jobs in Dexie so retries survive page reloads.
 *
 * Two retry mechanisms:
 * 1. Polling backoff (fast tier: 2s/5s/10s, slow tier: 30s/2min/10min/1h)
 * 2. Event-driven: retryForRoom() called when keys arrive, retryAllWaiting() on online
 */
export class DecryptionWorker {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private processing = false;
  private disposed = false;

  constructor(
    private db: ChatDatabase,
    private getRoomCrypto: GetRoomCrypto,
    private roomRepo?: RoomRepository,
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
      status: "queued",
      attempts: 0,
      nextAttemptAt: Date.now() + FAST_BACKOFF_MS[0],
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

      const queuedJobs = await this.db.decryptionQueue
        .where("[status+nextAttemptAt]")
        .between(["queued", 0], ["queued", now], true, true)
        .limit(BATCH_SIZE)
        .toArray();

      const remaining = BATCH_SIZE - queuedJobs.length;
      const waitingJobs = remaining > 0
        ? await this.db.decryptionQueue
            .where("[status+nextAttemptAt]")
            .between(["waiting", 0], ["waiting", now], true, true)
            .limit(remaining)
            .toArray()
        : [];

      for (const job of [...queuedJobs, ...waitingJobs]) {
        await this.processJob(job);
      }
    } finally {
      this.processing = false;
      this.scheduleNext();
    }
  }

  /** Retry ALL jobs for a room (called when new keys arrive). Resets attempts. */
  async retryForRoom(roomId: string): Promise<void> {
    await this.db.decryptionQueue
      .where("roomId").equals(roomId)
      .filter(j => j.status !== "processing")
      .modify({
        status: "queued",
        attempts: 0,
        nextAttemptAt: Date.now(),
      });
    this.scheduleNext();
  }

  /**
   * Re-enqueue PERSISTED messages still showing as encrypted for a room.
   *
   * The queue can drift from reality: a message that failed to decrypt during a
   * key/RPC outage (e.g. the 502 wave) is persisted with `decryptionStatus`
   * "pending"/"failed" and its ciphertext in `encryptedBody`, but its queue job
   * may have died, been pruned, or never existed in this DB state — so
   * {@link retryForRoom} (which only touches existing jobs) can't recover it and
   * the message stays "[encrypted]" forever. This scans the authoritative
   * `messages` table and (re)creates queue jobs from the stored ciphertext.
   * Returns the number of messages re-queued.
   */
  async recoverStuckMessages(roomId: string): Promise<number> {
    const rows = await this.db.messages
      .where("[roomId+timestamp]")
      .between([roomId, 0], [roomId, Infinity], true, true)
      .filter(
        (m) =>
          !!m.encryptedBody &&
          !!m.eventId &&
          (m.decryptionStatus === "pending" || m.decryptionStatus === "failed"),
      )
      .toArray();

    let count = 0;
    for (const m of rows) {
      if (await this.requeueStuckMessage(m.eventId!, m.roomId, m.encryptedBody!)) count++;
    }
    if (count > 0) {
      console.info(`[decryption] recovered ${count} stuck message(s) for room ${roomId}`);
      this.scheduleNext();
    }
    return count;
  }

  /**
   * Boot-time sweep: re-enqueue stuck encrypted messages across ALL rooms (e.g.
   * after an outage where many rooms accumulated "[encrypted]" messages).
   *
   * Targets only `decryptionStatus: "pending"` — NOT "failed". "failed" is the
   * terminal state a message reaches after MAX_ATTEMPTS, so resurrecting it on
   * every boot would retry genuinely-undecryptable messages forever. Those are
   * instead resurrected only by a user-initiated/key-arrival signal (room open
   * or onKeysLoaded → {@link recoverStuckMessages}). Bounded by `limit` and
   * self-limiting: recovered rows flip to "ok" (or eventually "failed").
   */
  async recoverAllStuckMessages(limit = 500): Promise<number> {
    const rows = await this.db.messages
      .filter(
        (m) =>
          !!m.encryptedBody &&
          !!m.eventId &&
          !m.softDeleted &&
          m.decryptionStatus === "pending",
      )
      .limit(limit)
      .toArray();

    let count = 0;
    for (const m of rows) {
      if (await this.requeueStuckMessage(m.eventId!, m.roomId, m.encryptedBody!)) count++;
    }
    if (count > 0) {
      console.info(`[decryption] boot recovery re-queued ${count} stuck message(s)`);
      this.scheduleNext();
    }
    return count;
  }

  /** (Re)create a ready queue job for a persisted stuck message. Resets a
   *  dead/waiting job to queued; skips one that's currently processing.
   *  The read + write run in one rw transaction so the processing-skip guard
   *  is atomic against processJob (which flips status to "processing"). */
  private async requeueStuckMessage(
    eventId: string,
    roomId: string,
    encryptedBody: string,
  ): Promise<boolean> {
    return this.db.transaction("rw", this.db.decryptionQueue, async () => {
      const existing = await this.db.decryptionQueue
        .where("eventId").equals(eventId).first();
      if (existing) {
        if (existing.status === "processing") return false;
        await this.db.decryptionQueue.update(existing.id!, {
          status: "queued",
          attempts: 0,
          nextAttemptAt: Date.now(),
          encryptedBody,
        });
        return true;
      }
      await this.db.decryptionQueue.add({
        eventId,
        roomId,
        encryptedBody,
        status: "queued",
        attempts: 0,
        nextAttemptAt: Date.now(),
        createdAt: Date.now(),
      });
      return true;
    });
  }

  /** Retry all queued/waiting jobs immediately (called on online transition). */
  async retryAllWaiting(): Promise<void> {
    await this.db.decryptionQueue
      .where("status").anyOf(["queued", "waiting"])
      .modify({ nextAttemptAt: Date.now() });
    this.scheduleNext();
  }

  /** Get queue statistics for diagnostics. */
  async getStats(): Promise<{
    queued: number;
    waiting: number;
    processing: number;
    dead: number;
    oldestDeadAge?: number;
  }> {
    const all = await this.db.decryptionQueue.toArray();
    const dead = all.filter(j => j.status === "dead");
    return {
      queued: all.filter(j => j.status === "queued").length,
      waiting: all.filter(j => j.status === "waiting").length,
      processing: all.filter(j => j.status === "processing").length,
      dead: dead.length,
      oldestDeadAge: dead.length
        ? Date.now() - Math.min(...dead.map(j => j.createdAt))
        : undefined,
    };
  }

  /** Stop the worker and clear timers. */
  dispose(): void {
    this.disposed = true;
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

        // Update room preview if this is the latest message
        if (this.roomRepo) {
          await this.updateRoomPreviewIfLatest(msg.roomId, msg.eventId!, result.body, msg.senderId, msg.type, msg.timestamp);
        }
      }

      // Clear room-level decryption status
      try {
        const room = await this.db.rooms.where("id").equals(job.roomId).first();
        if (room && room.lastMessageEventId === job.eventId) {
          await this.db.rooms.update(job.roomId, {
            lastMessageDecryptionStatus: undefined,
          });
        }
      } catch { /* non-critical */ }

      // Remove completed job
      await this.db.decryptionQueue.delete(job.id!);
    } catch (e) {
      const attempts = job.attempts + 1;
      const isDead = attempts >= MAX_ATTEMPTS;

      cryptoDebug("retry:fail", {
        eventId: job.eventId,
        roomId: job.roomId,
        attempts,
        isDead,
        error: e instanceof Error ? e.message : String(e),
      });

      let delay: number;
      if (attempts <= FAST_BACKOFF_MS.length) {
        delay = FAST_BACKOFF_MS[attempts - 1];
      } else {
        const slowIdx = Math.min(
          attempts - FAST_BACKOFF_MS.length - 1,
          SLOW_BACKOFF_MS.length - 1,
        );
        delay = SLOW_BACKOFF_MS[slowIdx];
      }
      const jitter = Math.random() * delay * 0.2;

      await this.db.decryptionQueue.update(job.id!, {
        status: isDead ? "dead" : "waiting",
        attempts,
        nextAttemptAt: isDead ? 0 : Date.now() + delay + jitter,
        lastError: String(e instanceof Error ? e.message : e),
      });

      // Mark message as failed if dead
      if (isDead) {
        const msg = await this.db.messages
          .where("eventId").equals(job.eventId).first();
        if (msg) {
          await this.db.messages.update(msg.localId!, {
            decryptionStatus: "failed",
          });
        }

        try {
          const room = await this.db.rooms.where("id").equals(job.roomId).first();
          if (room && room.lastMessageEventId === job.eventId) {
            await this.db.rooms.update(job.roomId, {
              lastMessageDecryptionStatus: "failed",
            });
          }
        } catch { /* non-critical */ }
      }
    }
  }

  /** Update room preview if the decrypted message is the latest in the room */
  private async updateRoomPreviewIfLatest(
    roomId: string,
    eventId: string,
    decryptedBody: string,
    senderId: string,
    type: MessageType,
    timestamp: number,
  ): Promise<void> {
    if (!this.roomRepo) return;
    try {
      const room = await this.roomRepo.getRoom(roomId);
      if (!room) return;
      if (room.lastMessageEventId === eventId ||
          ((room.lastMessagePreview === "[encrypted]" || room.lastMessagePreview === "") &&
           timestamp >= (room.lastMessageTimestamp ?? 0))) {
        let preview = decryptedBody;
        if (type === MessageType.image) preview = "[photo]";
        else if (type === MessageType.video) preview = "[video]";
        else if (type === MessageType.audio) preview = "[voice message]";
        else if (type === MessageType.file) preview = "[file]";
        else if (type === MessageType.poll) preview = "[poll]";
        await this.roomRepo.updateLastMessage(roomId, preview, timestamp, senderId, type, eventId);
      }
    } catch {
      // Non-critical — preview will be stale but messages still visible
    }
  }

  private scheduleNext(): void {
    if (this.disposed) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    void (async () => {
      try {
        if (this.disposed) return;
        const nextQueued = await this.db.decryptionQueue
          .where("[status+nextAttemptAt]")
          .between(["queued", 0], ["queued", Infinity], true, true)
          .first();

        if (this.disposed) return;
        const nextWaiting = await this.db.decryptionQueue
          .where("[status+nextAttemptAt]")
          .between(["waiting", 0], ["waiting", Infinity], true, true)
          .first();

        if (this.disposed) return;
        const candidates = [nextQueued, nextWaiting].filter(Boolean) as DecryptionJob[];
        if (candidates.length === 0) return;

        const nearest = Math.min(...candidates.map(j => j.nextAttemptAt));
        const delay = Math.max(0, nearest - Date.now());
        this.timer = setTimeout(() => this.tick(), Math.min(delay, 60_000));
      } catch {
        if (!this.disposed) {
          this.timer = setTimeout(() => this.tick(), 30_000);
        }
      }
    })();
  }
}
