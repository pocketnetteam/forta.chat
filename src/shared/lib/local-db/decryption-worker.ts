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
