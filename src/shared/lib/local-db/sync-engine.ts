import type { ChatDatabase, PendingOperation, LocalMessage } from "./schema";
import type { MessageRepository } from "./message-repository";
import type { RoomRepository } from "./room-repository";
import { getMatrixClientService } from "@/entities/matrix";
import type { PcryptoRoomInstance } from "@/entities/matrix/model/matrix-crypto";

type GetRoomCryptoFn = (roomId: string) => Promise<PcryptoRoomInstance | undefined>;
type OnChangeCallback = (roomId: string) => void;

const MAX_BACKOFF_MS = 30_000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
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

  /** Update online/offline state. Resumes queue on reconnect. */
  setOnline(isOnline: boolean): void {
    const wasOffline = !this.online;
    this.online = isOnline;
    if (isOnline && wasOffline) {
      this.processQueue();
    }
  }

  /** Set the callback invoked after a successful sync operation */
  setOnChange(cb: OnChangeCallback): void {
    this.onChange = cb;
  }

  // ---------------------------------------------------------------------------
  // Queue processing
  // ---------------------------------------------------------------------------

  /** Process pending operations in FIFO order. Re-entrant safe. */
  async processQueue(): Promise<void> {
    if (this.processing || !this.online) return;
    this.processing = true;

    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        if (!this.online) break;

        const op = await this.db.pendingOps
          .where("status")
          .equals("pending")
          .sortBy("createdAt")
          .then((ops) => ops[0]);

        if (!op) break;

        await this.db.pendingOps.update(op.id!, { status: "syncing" });

        try {
          await this.executeOperation(op);
          // Success — remove from queue
          await this.db.pendingOps.delete(op.id!);
          this.onChange?.(op.roomId);
        } catch (e) {
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
            // Put back as pending for retry
            await this.db.pendingOps.update(op.id!, {
              status: "pending",
              retries,
              lastAttemptAt: Date.now(),
            });
            // Exponential backoff before next attempt
            const delay = Math.min(1000 * 2 ** retries, MAX_BACKOFF_MS);
            await sleep(delay);
          }
        }
      }
    } finally {
      this.processing = false;
    }
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
      .modify({ status: "pending", retries: 0, errorMessage: undefined });
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
