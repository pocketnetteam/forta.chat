import type { ChatDatabase, PendingOperation, LocalMessage } from "./schema";
import type { MessageRepository } from "./message-repository";
import type { RoomRepository } from "./room-repository";
import { getMatrixClientService } from "@/entities/matrix";
import type { PcryptoRoomInstance } from "@/entities/matrix/model/matrix-crypto";

type GetRoomCryptoFn = (roomId: string) => Promise<PcryptoRoomInstance | undefined>;
type OnChangeCallback = (roomId: string) => void;

const MAX_BACKOFF_MS = 30_000;
const MIN_BACKOFF_MS = 1_000;

function computeBackoff(retries: number): number {
  const base = Math.min(MIN_BACKOFF_MS * 2 ** retries, MAX_BACKOFF_MS);
  return base + Math.random() * Math.min(base * 0.5, 5_000);
}

/**
 * SyncEngine processes pending operations (outbound queue).
 *
 * Lifecycle:
 *   1. User action → MessageRepository writes to local DB + creates PendingOp
 *   2. SyncEngine.processQueue() picks up ops in FIFO order
 *   3. Each op: encrypt if needed → call Matrix API → update local message status
 *   4. On failure: exponential backoff + retry, or mark as "failed"
 *
 * The engine is connectivity-aware: `setOnline(false)` pauses processing,
 * `setOnline(true)` resumes.
 */
export class SyncEngine {
  private processing = false;
  private online = true;
  private scheduled = false;
  private disposed = false;
  private scheduledTimer: ReturnType<typeof setTimeout> | null = null;
  /** Becomes true the first time setOnline() is called with `true`.
   *  Guards against the "app started offline from a previous session and
   *  wakes up online without ever seeing setOnline(false)" case, where
   *  wasOffline would be `false` and failed ops would never get retried. */
  private hasSeenFirstOnline = false;
  private getRoomCrypto: GetRoomCryptoFn;
  private onChange?: OnChangeCallback;

  constructor(
    private db: ChatDatabase,
    private messageRepo: MessageRepository,
    private roomRepo: RoomRepository,
    getRoomCrypto: GetRoomCryptoFn,
    onChange?: OnChangeCallback,
  ) {
    this.getRoomCrypto = getRoomCrypto;
    this.onChange = onChange;
  }

  /** Update online/offline state. Resumes queue on reconnect and
   *  re-arms any operations that died as "failed" while we were offline so
   *  the user does not have to tap Retry manually after coming back online. */
  setOnline(isOnline: boolean): void {
    const wasOffline = !this.online;
    this.online = isOnline;
    if (!isOnline) return;

    // Trigger retryAllFailed on BOTH: the offline→online edge, AND the very
    // first online signal after construction. The second case matters because
    // this.online is initialized to `true` — so a fresh instance whose first
    // incoming signal is `setOnline(true)` would otherwise see wasOffline=false
    // and skip retrying any failed ops carried over from a previous session.
    const shouldRetry = wasOffline || !this.hasSeenFirstOnline;
    this.hasSeenFirstOnline = true;

    if (shouldRetry) {
      // Fire-and-forget — retryAllFailed itself calls processQueue().
      // NOTE: we intentionally do NOT call recoverStrandedOps() here because
      // it has a race with an already-in-flight processQueue() (it could
      // reset a "syncing" op that's mid-execution). recoverStrandedOps is
      // documented as "call once at startup before processQueue()" — callers
      // own that ordering.
      this.retryAllFailed().catch((e) => {
        console.warn("[SyncEngine] retryAllFailed on reconnect failed:", e);
        this.processQueue();
      });
    }
  }

  /**
   * Recover operations stranded in "syncing" state (e.g. after app crash mid-send).
   * Resets them back to "pending" so processQueue() will pick them up.
   * Must be called once at startup before processQueue().
   */
  async recoverStrandedOps(): Promise<void> {
    const stranded = await this.db.pendingOps
      .where("status")
      .equals("syncing")
      .toArray();

    if (stranded.length === 0) return;

    console.info(`[SyncEngine] Recovering ${stranded.length} stranded "syncing" ops`);

    for (const op of stranded) {
      await this.db.pendingOps.update(op.id!, {
        status: "pending",
        retries: 0,
      });
      // Also reset the associated message status so UI shows "sending" not stuck
      if (op.clientId) {
        await this.messageRepo.updateStatus({ clientId: op.clientId }, "pending");
      }
    }
  }

  /** Set the callback invoked after a successful sync operation */
  setOnChange(cb: OnChangeCallback): void {
    this.onChange = cb;
  }

  // ---------------------------------------------------------------------------
  // Queue processing
  // ---------------------------------------------------------------------------

  /**
   * Process one op from the queue per tick, then yield to the event loop.
   * Re-schedules itself via setTimeout until the queue is empty or a retry
   * is not yet due. This prevents head-of-line blocking: a single failing op
   * cannot hold the queue for its 30s backoff.
   *
   * External callers use the public `processQueue()` which is a thin wrapper
   * kicking off the first tick without double-scheduling.
   */
  async processQueue(): Promise<void> {
    this.kickScheduler(0);
  }

  /**
   * Fully stop the engine: clear scheduled wake-up timers and refuse further
   * ticks. Intended for shutdown and tests.
   */
  dispose(): void {
    this.disposed = true;
    this.online = false;
    if (this.scheduledTimer !== null) {
      clearTimeout(this.scheduledTimer);
      this.scheduledTimer = null;
    }
    this.scheduled = false;
  }

  /** Schedule processTick after `delayMs` unless a tick is already pending. */
  private kickScheduler(delayMs: number): void {
    if (this.disposed || this.scheduled || this.processing || !this.online) return;
    this.scheduled = true;
    this.scheduledTimer = setTimeout(() => {
      this.scheduledTimer = null;
      this.processTick();
    }, Math.max(0, delayMs));
  }

  private async processTick(): Promise<void> {
    this.scheduled = false;
    if (this.disposed || this.processing || !this.online) return;
    this.processing = true;

    let op: PendingOperation | null = null;
    let nextRetryDelay: number | null = null; // smallest remaining wait

    try {
      // Claim one due pending op transactionally so concurrent engines
      // (multi-tab) can't both pick the same record.
      op = await this.claimDueOp();

      if (!op) {
        // Nothing due right now — check whether an op is scheduled for later
        // so we can set a wake-up timer and then stop this tick cleanly.
        nextRetryDelay = await this.findNextRetryDelay();
        return;
      }

      try {
        await this.executeOperation(op);
        // If dispose() was called while the send was in flight, skip writing
        // to a DB we no longer own. The send itself already landed server-side;
        // the next engine instance will reconcile via Matrix sync.
        if (this.disposed) return;
        await this.db.pendingOps.delete(op.id!);
        this.onChange?.(op.roomId);
      } catch (e) {
        if (this.disposed) return;
        const retries = op.retries + 1;
        if (retries >= op.maxRetries) {
          await this.db.pendingOps.update(op.id!, {
            status: "failed",
            retries,
            errorMessage: String(e),
            lastAttemptAt: Date.now(),
          });
          await this.markMessageFailed(op);
          this.onChange?.(op.roomId);
        } else {
          const delay = computeBackoff(retries);
          await this.db.pendingOps.update(op.id!, {
            status: "pending",
            retries,
            lastAttemptAt: Date.now(),
            nextAttemptAt: Date.now() + delay,
          });
          // We don't `await sleep(delay)` here — other due ops must proceed
          // immediately. The delay is tracked via nextAttemptAt in the DB,
          // and a wake-up timer is scheduled in the finally block below.
        }
      }
    } finally {
      this.processing = false;
      if (this.online) {
        if (op) {
          // We just processed one op. Immediately yield and check for the
          // next due op. claimDueOp will skip any op whose nextAttemptAt is
          // still in the future.
          this.kickScheduler(0);
        } else if (nextRetryDelay !== null) {
          // Queue is empty of due ops but a retry is scheduled for later.
          // Set a single wake-up timer so that retry is actually attempted.
          this.scheduleWake(nextRetryDelay);
        }
      }
    }
  }

  /**
   * Atomically claim the next due pending op (status = "pending"
   * and nextAttemptAt <= now). Returns null if nothing is due.
   *
   * Uses the [status+nextAttemptAt] compound index added in v11 so this is
   * O(log n) even with thousands of queued ops. Freshly-enqueued ops get
   * nextAttemptAt=0 and are naturally prioritised over retry-scheduled ops
   * (which have larger nextAttemptAt values). Within the same nextAttemptAt
   * bucket Dexie falls back to the primary key order, which is creation
   * order for `++id` — preserving FIFO for fresh sends.
   */
  private async claimDueOp(): Promise<PendingOperation | null> {
    return this.db.transaction("rw", this.db.pendingOps, async () => {
      const now = Date.now();
      const due = await this.db.pendingOps
        .where("[status+nextAttemptAt]")
        .between(["pending", -Infinity], ["pending", now], true, true)
        .first();
      if (!due) return null;
      await this.db.pendingOps.update(due.id!, { status: "syncing" });
      return { ...due, status: "syncing" };
    });
  }

  /**
   * Look at pending ops scheduled for the future and return the smallest
   * remaining wait (in ms). Used to set a wake-up timer when the queue has
   * no immediately-due work but will have work later. O(log n) via the
   * [status+nextAttemptAt] compound index — only reads the first future op.
   */
  private async findNextRetryDelay(): Promise<number | null> {
    const now = Date.now();
    const soonest = await this.db.pendingOps
      .where("[status+nextAttemptAt]")
      .above(["pending", now])
      .first();
    if (!soonest) return null;
    const delay = (soonest.nextAttemptAt ?? 0) - now;
    return delay > 0 ? delay : null;
  }

  /** Schedule a future tick to pick up retry-scheduled ops. */
  private scheduleWake(delayMs: number): void {
    this.kickScheduler(delayMs);
  }

  // ---------------------------------------------------------------------------
  // Operation dispatch
  // ---------------------------------------------------------------------------

  private async executeOperation(op: PendingOperation): Promise<void> {
    switch (op.type) {
      case "send_message":
        return this.syncSendMessage(op);
      case "send_file":
        return this.syncSendFile(op);
      case "edit_message":
        return this.syncEditMessage(op);
      case "delete_message":
        return this.syncDeleteMessage(op);
      case "send_reaction":
        return this.syncSendReaction(op);
      case "remove_reaction":
        return this.syncRemoveReaction(op);
      case "send_poll":
        return this.syncSendPoll(op);
      case "vote_poll":
        return this.syncVotePoll(op);
      case "send_transfer":
        return this.syncSendTransfer(op);
      default:
        console.warn("[SyncEngine] Unknown operation type:", op.type);
    }
  }

  // ---------------------------------------------------------------------------
  // Operation implementations
  // ---------------------------------------------------------------------------

  private async syncSendMessage(op: PendingOperation): Promise<void> {
    const payload = op.payload as {
      content: string;
      replyToEventId?: string;
      forwardedFrom?: { senderId: string; senderName?: string };
      noPreview?: boolean;
    };
    const matrixService = getMatrixClientService();
    const roomCrypto = await this.getRoomCrypto(op.roomId);

    let serverEventId: string;
    if (roomCrypto?.canBeEncrypt()) {
      const encrypted = await roomCrypto.encryptEvent(payload.content);

      // Add reply relation if present
      if (payload.replyToEventId) {
        (encrypted as Record<string, unknown>)["m.relates_to"] = {
          "m.in_reply_to": { event_id: payload.replyToEventId },
        };
      }
      // Add forward metadata
      if (payload.forwardedFrom) {
        (encrypted as Record<string, unknown>)["forwarded_from"] = {
          sender_id: payload.forwardedFrom.senderId,
          sender_name: payload.forwardedFrom.senderName,
        };
      }
      // Signal that sender explicitly dismissed the preview
      if (payload.noPreview) {
        (encrypted as Record<string, unknown>).no_preview = true;
      }

      serverEventId = await matrixService.sendEncryptedText(op.roomId, encrypted, op.clientId);
    } else {
      const content: Record<string, unknown> = {
        msgtype: "m.text",
        body: payload.content,
      };
      if (payload.replyToEventId) {
        content["m.relates_to"] = {
          "m.in_reply_to": { event_id: payload.replyToEventId },
        };
      }
      if (payload.forwardedFrom) {
        content["forwarded_from"] = {
          sender_id: payload.forwardedFrom.senderId,
          sender_name: payload.forwardedFrom.senderName,
        };
      }
      if (payload.noPreview) {
        content.no_preview = true;
      }
      serverEventId = await matrixService.sendEncryptedText(op.roomId, content, op.clientId);
    }

    // Update local message: pending → synced
    await this.messageRepo.confirmSent(op.clientId, serverEventId);
    // Update room preview status so sidebar shows ✓ instead of pending
    await this.roomRepo.updateRoom(op.roomId, {
      lastMessageLocalStatus: "synced" as import("./schema").LocalMessageStatus,
      lastMessageEventId: serverEventId,
    });
  }

  private async syncSendFile(op: PendingOperation): Promise<void> {
    const payload = op.payload as {
      fileName: string;
      mimeType: string;
      msgtype: string;
      attachmentId: number;
    };
    const matrixService = getMatrixClientService();

    // Get the attachment blob from DB
    const attachment = await this.db.attachments.get(payload.attachmentId);
    if (!attachment?.localBlob) {
      throw new Error("Attachment blob not found");
    }

    // Upload file
    const roomCrypto = await this.getRoomCrypto(op.roomId);
    let mxcUrl: string;
    let secrets: Record<string, unknown> | undefined;

    if (roomCrypto?.canBeEncrypt()) {
      const encrypted = await roomCrypto.encryptFile(attachment.localBlob);
      mxcUrl = await matrixService.uploadContentMxc(encrypted.file);
      secrets = encrypted.secrets;
    } else {
      mxcUrl = await matrixService.uploadContentMxc(attachment.localBlob);
    }

    // Update attachment status
    await this.db.attachments.update(attachment.id!, {
      status: "uploaded",
      remoteUrl: mxcUrl,
      encryptionSecrets: secrets,
    });

    // Send message event with file metadata
    const content: Record<string, unknown> = {
      msgtype: payload.msgtype,
      body: JSON.stringify({
        name: payload.fileName,
        type: payload.mimeType,
        size: attachment.size,
      }),
      url: mxcUrl,
    };
    if (secrets) {
      content.secrets = secrets;
    }

    const serverEventId = await matrixService.sendEncryptedText(op.roomId, content);
    await this.messageRepo.confirmSent(op.clientId, serverEventId);
    await this.roomRepo.updateRoom(op.roomId, {
      lastMessageLocalStatus: "synced" as import("./schema").LocalMessageStatus,
      lastMessageEventId: serverEventId,
    });
  }

  private async syncEditMessage(op: PendingOperation): Promise<void> {
    const payload = op.payload as { eventId: string; newContent: string };
    const matrixService = getMatrixClientService();
    const roomCrypto = await this.getRoomCrypto(op.roomId);

    let body: string | Record<string, unknown> = payload.newContent;
    const content: Record<string, unknown> = {
      "m.relates_to": {
        rel_type: "m.replace",
        event_id: payload.eventId,
      },
    };

    if (roomCrypto?.canBeEncrypt()) {
      const encrypted = await roomCrypto.encryptEvent(payload.newContent);
      content.msgtype = "m.encrypted";
      content.body = (encrypted as Record<string, unknown>).body;
      content.block = (encrypted as Record<string, unknown>).block;
      content.version = (encrypted as Record<string, unknown>).version;
      content["m.new_content"] = encrypted;
    } else {
      content.msgtype = "m.text";
      content.body = `* ${payload.newContent}`;
      content["m.new_content"] = {
        msgtype: "m.text",
        body: payload.newContent,
      };
    }

    await matrixService.sendEncryptedText(op.roomId, content);
  }

  private async syncDeleteMessage(op: PendingOperation): Promise<void> {
    const payload = op.payload as { eventId: string };
    const matrixService = getMatrixClientService();
    await matrixService.redactEvent(op.roomId, payload.eventId);
  }

  private async syncSendReaction(op: PendingOperation): Promise<void> {
    const payload = op.payload as { eventId: string; emoji: string };
    const matrixService = getMatrixClientService();
    const reactionEventId = await matrixService.sendReaction(
      op.roomId,
      payload.eventId,
      payload.emoji,
    );

    // Store the reaction eventId so we can remove it later
    const msg = await this.messageRepo.getByEventId(payload.eventId);
    if (msg?.reactions?.[payload.emoji]) {
      msg.reactions[payload.emoji].myEventId = reactionEventId;
      await this.messageRepo.updateReactions(payload.eventId, msg.reactions);
    }
  }

  private async syncRemoveReaction(op: PendingOperation): Promise<void> {
    const payload = op.payload as { eventId: string; reactionEventId: string };
    const matrixService = getMatrixClientService();
    await matrixService.redactEvent(op.roomId, payload.reactionEventId);
  }

  private async syncSendPoll(op: PendingOperation): Promise<void> {
    const payload = op.payload as { question: string; options: string[] };
    const matrixService = getMatrixClientService();

    const answers = payload.options.map((text, i) => ({
      id: `option_${i}`,
      "org.matrix.msc1767.text": text,
      body: text,
    }));

    await matrixService.sendPollStart(op.roomId, {
      "org.matrix.msc3381.poll.start": {
        kind: "org.matrix.msc3381.poll.disclosed",
        question: { body: payload.question, "org.matrix.msc1767.text": payload.question },
        answers,
        max_selections: 1,
      },
    });

    const pollEventId = `poll_${Date.now()}`;
    await this.messageRepo.confirmSent(op.clientId, pollEventId);
    await this.roomRepo.updateRoom(op.roomId, {
      lastMessageLocalStatus: "synced" as import("./schema").LocalMessageStatus,
      lastMessageEventId: pollEventId,
    });
  }

  private async syncVotePoll(op: PendingOperation): Promise<void> {
    const payload = op.payload as { pollEventId: string; optionId: string };
    const matrixService = getMatrixClientService();

    await matrixService.sendPollResponse(op.roomId, {
      "m.relates_to": {
        rel_type: "m.reference",
        event_id: payload.pollEventId,
      },
      "org.matrix.msc3381.poll.response": {
        answers: [payload.optionId],
      },
    });
  }

  private async syncSendTransfer(op: PendingOperation): Promise<void> {
    const payload = op.payload as {
      txId: string;
      amount: number;
      from: string;
      to: string;
      message?: string;
    };
    const matrixService = getMatrixClientService();
    const roomCrypto = await this.getRoomCrypto(op.roomId);

    // Encode transfer as JSON body (same format as use-messages.ts)
    const transferBody = JSON.stringify({
      _transfer: true,
      txId: payload.txId,
      amount: payload.amount,
      from: payload.from,
      to: payload.to,
      message: payload.message,
    });

    let serverEventId: string;
    if (roomCrypto?.canBeEncrypt()) {
      const encrypted = await roomCrypto.encryptEvent(transferBody);
      serverEventId = await matrixService.sendEncryptedText(op.roomId, encrypted);
    } else {
      serverEventId = await matrixService.sendText(op.roomId, transferBody);
    }

    await this.messageRepo.confirmSent(op.clientId, serverEventId);
    await this.roomRepo.updateRoom(op.roomId, {
      lastMessageLocalStatus: "synced" as import("./schema").LocalMessageStatus,
      lastMessageEventId: serverEventId,
    });
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /** Mark the message associated with a failed operation */
  private async markMessageFailed(op: PendingOperation): Promise<void> {
    if (op.clientId) {
      await this.messageRepo.updateStatus(
        { clientId: op.clientId },
        "failed",
      );
    }
  }

  /** Enqueue a new operation. Returns the operation ID. */
  async enqueue(
    type: PendingOperation["type"],
    roomId: string,
    payload: Record<string, unknown>,
    clientId?: string,
    maxRetries = 5,
  ): Promise<number> {
    const id = await this.db.pendingOps.add({
      type,
      roomId,
      payload,
      status: "pending",
      retries: 0,
      maxRetries,
      createdAt: Date.now(),
      clientId: clientId ?? crypto.randomUUID(),
      nextAttemptAt: 0, // due immediately
    });

    // Kick off processing (non-blocking)
    this.processQueue();
    return id as number;
  }

  /** Retry a specific failed operation */
  async retryOperation(opId: number): Promise<void> {
    await this.db.pendingOps.update(opId, {
      status: "pending",
      retries: 0,
      errorMessage: undefined,
      nextAttemptAt: 0,
    });
    // Also reset the associated message status
    const op = await this.db.pendingOps.get(opId);
    if (op?.clientId) {
      await this.messageRepo.updateStatus({ clientId: op.clientId }, "pending");
    }
    this.processQueue();
  }

  /** Retry all failed operations */
  async retryAllFailed(): Promise<void> {
    await this.db.pendingOps
      .where("status")
      .equals("failed")
      .modify({ status: "pending", retries: 0, errorMessage: undefined, nextAttemptAt: 0 });
    this.processQueue();
  }

  /** Get count of pending/failed operations */
  async getQueueStatus(): Promise<{ pending: number; failed: number }> {
    const pending = await this.db.pendingOps.where("status").equals("pending").count();
    const failed = await this.db.pendingOps.where("status").equals("failed").count();
    return { pending, failed };
  }

  /** Cancel a pending/failed operation and clean up */
  async cancelOperation(opId: number): Promise<void> {
    const op = await this.db.pendingOps.get(opId);
    if (!op) return;

    // Remove the pending message if it was a send
    if (op.type === "send_message" || op.type === "send_file" || op.type === "send_transfer") {
      const msg = await this.messageRepo.getByClientId(op.clientId);
      if (msg?.localId && !msg.eventId) {
        await this.db.messages.delete(msg.localId);
      }
    }

    await this.db.pendingOps.delete(opId);
    this.onChange?.(op.roomId);
  }
}
