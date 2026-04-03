import Dexie from "dexie";
import type { ChatDatabase, LocalMessage, LocalMessageStatus } from "./schema";
import { MessageType } from "@/entities/chat/model/types";
import type { ReplyTo } from "@/entities/chat/model/types";

export class MessageRepository {
  constructor(private db: ChatDatabase) {}

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  /** Load messages for a room (paginated, chronological order).
   *  Returns up to `limit` messages with timestamp < `beforeTimestamp`. */
  async getMessages(
    roomId: string,
    limit = 50,
    beforeTimestamp?: number,
    clearedAtTs?: number,
  ): Promise<LocalMessage[]> {
    const upper = beforeTimestamp ?? Dexie.maxKey;
    const lower = clearedAtTs ?? Dexie.minKey;
    const msgs = await this.db.messages
      .where("[roomId+timestamp]")
      .between([roomId, lower], [roomId, upper], !clearedAtTs, !beforeTimestamp)
      .reverse()
      .limit(limit)
      .toArray();

    return msgs.reverse();
  }

  /** Get a single message by server eventId */
  async getByEventId(eventId: string): Promise<LocalMessage | undefined> {
    return this.db.messages.where("eventId").equals(eventId).first();
  }

  /** Get multiple messages by server eventIds (single query) */
  async getByEventIds(eventIds: string[]): Promise<LocalMessage[]> {
    if (eventIds.length === 0) return [];
    return this.db.messages.where("eventId").anyOf(eventIds).toArray();
  }

  /** Get a single message by clientId */
  async getByClientId(clientId: string): Promise<LocalMessage | undefined> {
    return this.db.messages.where("clientId").equals(clientId).first();
  }

  /** Get pending/failed messages for a room */
  async getPendingMessages(roomId: string): Promise<LocalMessage[]> {
    const pending = await this.db.messages
      .where("[roomId+status]")
      .anyOf([
        [roomId, "pending"],
        [roomId, "syncing"],
        [roomId, "failed"],
      ])
      .toArray();
    return pending.sort((a, b) => a.timestamp - b.timestamp);
  }

  /** Get the last non-deleted message in a room (for preview after deletion) */
  async getLastNonDeleted(roomId: string, clearedAtTs?: number): Promise<LocalMessage | undefined> {
    const lower = clearedAtTs ?? Dexie.minKey;
    const msgs = await this.db.messages
      .where("[roomId+timestamp]")
      .between([roomId, lower], [roomId, Dexie.maxKey], !clearedAtTs, true)
      .reverse()
      .filter((m) => !m.softDeleted && !m.deleted)
      .limit(1)
      .toArray();
    return msgs[0];
  }

  // ---------------------------------------------------------------------------
  // Writes (local-first)
  // ---------------------------------------------------------------------------

  /** Create a new message locally (pending sync).
   *  Atomically updates room preview so sidebar reflects the sent message instantly. */
  async createLocal(params: {
    roomId: string;
    senderId: string;
    content: string;
    type?: MessageType;
    replyTo?: ReplyTo;
    forwardedFrom?: LocalMessage["forwardedFrom"];
    transferInfo?: LocalMessage["transferInfo"];
    pollInfo?: LocalMessage["pollInfo"];
    fileInfo?: LocalMessage["fileInfo"];
    localBlobUrl?: string;
    uploadProgress?: number;
  }): Promise<LocalMessage> {
    const clientId = crypto.randomUUID();
    const now = Date.now();
    const msgType = params.type ?? MessageType.text;

    const message: LocalMessage = {
      eventId: null,
      clientId,
      roomId: params.roomId,
      senderId: params.senderId,
      content: params.content,
      timestamp: now,
      type: msgType,
      status: "pending",
      version: 1,
      softDeleted: false,
      replyTo: params.replyTo,
      forwardedFrom: params.forwardedFrom,
      transferInfo: params.transferInfo,
      pollInfo: params.pollInfo,
      fileInfo: params.fileInfo,
      localBlobUrl: params.localBlobUrl,
      uploadProgress: params.uploadProgress,
    };

    await this.db.transaction("rw", [this.db.messages, this.db.rooms], async () => {
      const localId = await this.db.messages.add(message);
      message.localId = localId as number;

      // Atomically update room preview so sidebar reflects sent message instantly
      const preview = this.getPreviewText(msgType, params.content, params.transferInfo?.amount);
      await this.db.rooms.update(params.roomId, {
        lastMessagePreview: preview.slice(0, 200),
        lastMessageTimestamp: now,
        lastMessageSenderId: params.senderId,
        lastMessageType: msgType,
        lastMessageLocalStatus: "pending" as import("./schema").LocalMessageStatus,
        lastMessageReaction: null,
        updatedAt: now,
      });
    });

    return message;
  }

  /** Generate preview text for sidebar display */
  private getPreviewText(type: MessageType, content: string, transferAmount?: number): string {
    if (type === MessageType.image) return "[photo]";
    if (type === MessageType.video) return "[video]";
    if (type === MessageType.audio) return "[voice message]";
    if (type === MessageType.file) return "[file]";
    if (type === MessageType.poll) return "[poll]";
    if (type === MessageType.transfer) return `[transfer] ${transferAmount ?? 0} PKOIN`;
    return content;
  }

  /** Insert or update a message from the server (incoming sync).
   *  Returns "inserted" | "updated" | "duplicate". */
  async upsertFromServer(msg: LocalMessage, clearedAtTs?: number): Promise<"inserted" | "updated" | "duplicate"> {
    // Write-guard: skip events that predate the clear-history marker
    if (clearedAtTs && msg.timestamp <= clearedAtTs) {
      return "duplicate";
    }

    // 1. Check if this is our own message echo (match by clientId)
    if (msg.clientId) {
      const existing = await this.getByClientId(msg.clientId);
      if (existing) {
        // If upload is still in-flight (has localBlobUrl) and hasn't failed,
        // only store eventId — let confirmMediaSent handle the final status transition.
        // If the message is already "failed", the upload pipeline is dead and we should
        // accept the server echo as the source of truth.
        if (existing.localBlobUrl && existing.status !== "failed") {
          await this.db.messages.update(existing.localId!, {
            eventId: msg.eventId,
            serverTs: msg.serverTs ?? msg.timestamp,
          });
        } else {
          await this.db.messages.update(existing.localId!, {
            eventId: msg.eventId,
            status: "synced" as LocalMessageStatus,
            serverTs: msg.serverTs ?? msg.timestamp,
          });
        }
        return "updated";
      }
    }

    // 2. Check if eventId already exists (duplicate sync)
    if (msg.eventId) {
      const byEvent = await this.getByEventId(msg.eventId);
      if (byEvent) return "duplicate";
    }

    // 3. New message from another user
    await this.db.messages.add(msg);
    return "inserted";
  }

  /** Bulk insert messages (e.g., initial room load / pagination) */
  async bulkInsert(messages: LocalMessage[], clearedAtTs?: number): Promise<void> {
    // Write-guard: skip events that predate the clear-history marker
    if (clearedAtTs) {
      messages = messages.filter(m => m.timestamp > clearedAtTs);
    }
    if (messages.length === 0) return;

    const eventIds = messages
      .map((m) => m.eventId)
      .filter((id): id is string => id !== null);

    // Collect existing eventIds
    const existingEventIds = new Set<string>();
    if (eventIds.length > 0) {
      const existingEvents = await this.db.messages
        .where("eventId")
        .anyOf(eventIds)
        .toArray();
      for (const e of existingEvents) {
        if (e.eventId) existingEventIds.add(e.eventId);
      }
    }

    // Collect clientIds to check against pending messages
    const clientIds = messages
      .map((m) => m.clientId)
      .filter((id): id is string => !!id);
    const existingClientIds = new Set<string>();
    if (clientIds.length > 0) {
      const existingByClient = await this.db.messages
        .where("clientId")
        .anyOf(clientIds)
        .toArray();
      for (const e of existingByClient) {
        if (e.clientId) existingClientIds.add(e.clientId);
        // Also update pending messages with server eventId
        if (e.status === "pending" || e.status === "syncing") {
          const incoming = messages.find((m) => m.clientId === e.clientId);
          if (incoming?.eventId && e.localId) {
            await this.db.messages.update(e.localId, {
              eventId: incoming.eventId,
              status: "synced" as LocalMessageStatus,
              serverTs: incoming.serverTs ?? incoming.timestamp,
            });
          }
        }
      }
    }

    const filtered = messages.filter(
      (m) =>
        (!m.eventId || !existingEventIds.has(m.eventId)) &&
        (!m.clientId || !existingClientIds.has(m.clientId)),
    );

    if (filtered.length > 0) {
      await this.db.messages.bulkAdd(filtered);
    }
  }

  // ---------------------------------------------------------------------------
  // Mutations (local-first, queue sync separately)
  // ---------------------------------------------------------------------------

  /** Mark a message as edited (local optimistic update) */
  async editLocal(eventId: string, newContent: string): Promise<void> {
    await this.db.messages
      .where("eventId")
      .equals(eventId)
      .modify((msg: LocalMessage) => {
        msg.content = newContent;
        msg.edited = true;
        msg.version++;
      });
  }

  /** Soft-delete a message locally */
  async softDelete(eventId: string): Promise<void> {
    await this.db.messages
      .where("eventId")
      .equals(eventId)
      .modify({
        softDeleted: true,
        deletedAt: Date.now(),
      });
  }

  /** Mark replyTo.deleted on all messages referencing a given eventId */
  async markReplyDeleted(deletedEventId: string): Promise<void> {
    // No index on nested replyTo.id — full table filter is unavoidable without schema migration.
    // Uses modify() to avoid read-modify-write race with concurrent reaction/edit updates.
    await this.db.messages
      .filter((m) => m.replyTo?.id === deletedEventId)
      .modify((m: LocalMessage) => {
        if (m.replyTo) {
          m.replyTo.deleted = true;
          m.replyTo.senderId = "";
          m.replyTo.content = "";
        }
      });
  }

  /** Patch unresolved replyTo on messages that were stored before the
   *  referenced message was available. Only overwrites when the existing
   *  replyTo has empty senderId AND content AND is not marked deleted.
   *  Called after loadRoomMessages resolves replies from timeline/Dexie. */
  async patchUnresolvedReplies(
    patches: { eventId: string; replyTo: ReplyTo }[],
  ): Promise<number> {
    if (patches.length === 0) return 0;
    let patched = 0;
    await this.db.transaction("rw", this.db.messages, async () => {
      for (const patch of patches) {
        const count = await this.db.messages
          .where("eventId")
          .equals(patch.eventId)
          .modify((msg: LocalMessage) => {
            // Only patch if replyTo exists, is unresolved, and not deleted
            if (
              msg.replyTo &&
              !msg.replyTo.deleted &&
              !msg.replyTo.senderId &&
              !msg.replyTo.content
            ) {
              msg.replyTo.senderId = patch.replyTo.senderId;
              msg.replyTo.content = patch.replyTo.content;
              msg.replyTo.type = patch.replyTo.type;
            }
          });
        patched += count;
      }
    });
    return patched;
  }

  /** Update reactions on a message */
  async updateReactions(
    eventId: string,
    reactions: LocalMessage["reactions"],
  ): Promise<void> {
    await this.db.messages
      .where("eventId")
      .equals(eventId)
      .modify({ reactions });
  }

  /** Update poll info on a message */
  async updatePollInfo(
    eventId: string,
    pollInfo: LocalMessage["pollInfo"],
  ): Promise<void> {
    await this.db.messages
      .where("eventId")
      .equals(eventId)
      .modify({ pollInfo });
  }

  /** Update message status */
  async updateStatus(
    identifier: { eventId?: string; clientId?: string },
    status: LocalMessageStatus,
  ): Promise<void> {
    if (identifier.eventId) {
      await this.db.messages
        .where("eventId")
        .equals(identifier.eventId)
        .modify({ status });
    } else if (identifier.clientId) {
      await this.db.messages
        .where("clientId")
        .equals(identifier.clientId)
        .modify({ status });
    }
  }

  /** Mark a pending message as failed (e.g. Matrix client not ready, enqueue error) */
  async markFailed(clientId: string): Promise<void> {
    await this.db.messages
      .where("clientId")
      .equals(clientId)
      .modify({ status: "failed" as LocalMessageStatus });
  }

  /** Update the eventId on a pending message (after server confirms) */
  async confirmSent(clientId: string, eventId: string): Promise<void> {
    await this.db.messages
      .where("clientId")
      .equals(clientId)
      .modify({
        eventId,
        status: "synced" as LocalMessageStatus,
        serverTs: Date.now(),
      });
  }

  /** Update upload progress for a media message */
  async updateUploadProgress(clientId: string, progress: number): Promise<void> {
    await this.db.messages
      .where("clientId")
      .equals(clientId)
      .modify({ uploadProgress: progress });
  }

  /** Mark media upload as complete — clear upload fields, update fileInfo URL */
  async confirmMediaSent(
    clientId: string,
    eventId: string,
    serverFileInfo: LocalMessage["fileInfo"],
    roomId: string,
  ): Promise<void> {
    await this.db.transaction('rw', [this.db.messages, this.db.rooms], async () => {
      await this.db.messages
        .where("clientId")
        .equals(clientId)
        .modify({
          eventId,
          status: "synced" as LocalMessageStatus,
          serverTs: Date.now(),
          fileInfo: serverFileInfo,
          uploadProgress: undefined,
          localBlobUrl: undefined,
        });
      // Update room list status — mirrors what syncSendMessage does in sync-engine.ts:228-231
      await this.db.rooms.update(roomId, {
        lastMessageLocalStatus: "synced" as LocalMessageStatus,
        lastMessageEventId: eventId,
      });
    });
  }

  /** Recover media messages stuck in "pending" from a previous session.
   *  Fire-and-forget upload IIFEs are lost on reload/crash — this marks
   *  orphaned uploads as "failed" so the user sees a retry button instead
   *  of an infinite spinner.
   *  @param maxAgeMs — only recover messages older than this (default 2 min) */
  async recoverStuckMedia(maxAgeMs = 2 * 60 * 1000): Promise<number> {
    const cutoff = Date.now() - maxAgeMs;
    // Note: "status" has no standalone index (only [roomId+status] compound).
    // Dexie falls back to a table scan, but this runs once at startup and
    // the JS filter narrows results quickly — acceptable tradeoff.
    return this.db.messages
      .where("status")
      .equals("pending")
      .filter((m) => m.uploadProgress !== undefined && m.timestamp < cutoff)
      .modify({
        status: "failed" as LocalMessageStatus,
        uploadProgress: undefined,
      });
  }

  /** Get the room ID for a given event (used by sync engine) */
  async getRoomIdForEvent(eventId: string): Promise<string | undefined> {
    const msg = await this.getByEventId(eventId);
    return msg?.roomId;
  }

  /** Count messages in a room */
  async countInRoom(roomId: string): Promise<number> {
    return this.db.messages
      .where("[roomId+timestamp]")
      .between([roomId, Dexie.minKey], [roomId, Dexie.maxKey])
      .count();
  }

  /** Delete all timeline messages in a room at or before a given timestamp.
   *  Returns count of deleted messages. */
  async purgeBeforeTimestamp(roomId: string, timestamp: number): Promise<number> {
    return this.db.messages
      .where("[roomId+timestamp]")
      .between([roomId, Dexie.minKey], [roomId, timestamp], true, true)
      .delete();
  }

  // ---------------------------------------------------------------------------
  // Unread UX helpers
  // ---------------------------------------------------------------------------

  /** Load messages around a timestamp for jump-to-unread.
   *  Returns `beforeCount` messages before ts + messages after ts up to `afterCount`. */
  async getMessagesAroundTimestamp(
    roomId: string,
    timestamp: number,
    beforeCount = 15,
    afterCount = 35,
    clearedAtTs?: number,
  ): Promise<{ messages: LocalMessage[]; anchorIndex: number }> {
    const lower = clearedAtTs ?? Dexie.minKey;
    const [before, after] = await Promise.all([
      this.db.messages
        .where("[roomId+timestamp]")
        .between([roomId, lower], [roomId, timestamp], !clearedAtTs, true)
        .reverse()
        .limit(beforeCount)
        .toArray(),
      this.db.messages
        .where("[roomId+timestamp]")
        .between([roomId, timestamp], [roomId, Dexie.maxKey], false, true)
        .limit(afterCount)
        .toArray(),
    ]);

    const messages = [...before.reverse(), ...after];
    const anchorIndex = before.length;
    return { messages, anchorIndex };
  }

  /** Count inbound messages after a timestamp (for unread count on banner). */
  async countInboundAfter(
    roomId: string,
    afterTimestamp: number,
    excludeSenderId: string,
    clearedAtTs?: number,
  ): Promise<number> {
    const effectiveAfter = clearedAtTs ? Math.max(afterTimestamp, clearedAtTs) : afterTimestamp;
    return this.db.messages
      .where("[roomId+timestamp]")
      .between([roomId, effectiveAfter], [roomId, Dexie.maxKey], false, true)
      .filter(m => m.senderId !== excludeSenderId && !m.softDeleted)
      .count();
  }

  /** Get the last message at or before a timestamp. */
  async getLastMessageAtOrBefore(
    roomId: string,
    timestamp: number,
    clearedAtTs?: number,
  ): Promise<LocalMessage | undefined> {
    const lower = clearedAtTs ?? Dexie.minKey;
    const msgs = await this.db.messages
      .where("[roomId+timestamp]")
      .between([roomId, lower], [roomId, timestamp], !clearedAtTs, true)
      .reverse()
      .limit(1)
      .toArray();
    return msgs[0];
  }

  /** Get the timestamp of the last inbound (non-own) message in a room */
  async getLastInboundTimestamp(roomId: string, myAddress: string, clearedAtTs?: number): Promise<number> {
    const lower = clearedAtTs ?? Dexie.minKey;
    const msgs = await this.db.messages
      .where("[roomId+timestamp]")
      .between([roomId, lower], [roomId, Dexie.maxKey], !clearedAtTs, true)
      .reverse()
      .filter(m => m.senderId !== myAddress)
      .limit(1)
      .toArray();
    return msgs[0]?.timestamp ?? 0;
  }

  // ---------------------------------------------------------------------------
  // Context & forward pagination (jump-to-message)
  // ---------------------------------------------------------------------------

  /** Find a message by eventId and return it with surrounding context.
   *  Returns `contextSize` messages before and after the target. */
  async getMessageContext(
    roomId: string,
    targetEventId: string,
    contextSize = 25,
    clearedAtTs?: number,
  ): Promise<{ messages: LocalMessage[]; targetIndex: number } | null> {
    const target = await this.getByEventId(targetEventId);
    if (!target || target.roomId !== roomId) return null;
    if (clearedAtTs && target.timestamp <= clearedAtTs) return null;

    const lower = clearedAtTs ?? Dexie.minKey;
    const [before, after] = await Promise.all([
      this.db.messages
        .where("[roomId+timestamp]")
        .between([roomId, lower], [roomId, target.timestamp], !clearedAtTs, false)
        .reverse()
        .limit(contextSize)
        .toArray(),
      this.db.messages
        .where("[roomId+timestamp]")
        .between([roomId, target.timestamp], [roomId, Dexie.maxKey], false, true)
        .limit(contextSize)
        .toArray(),
    ]);

    const all = [...before.reverse(), target, ...after];
    const targetIndex = all.findIndex(m => m.eventId === targetEventId);

    return { messages: all, targetIndex };
  }

  /** Load messages after a given timestamp (forward pagination for detached mode). */
  async getMessagesAfter(
    roomId: string,
    afterTimestamp: number,
    limit = 50,
    clearedAtTs?: number,
  ): Promise<LocalMessage[]> {
    const effectiveAfter = clearedAtTs ? Math.max(afterTimestamp, clearedAtTs) : afterTimestamp;
    const msgs = await this.db.messages
      .where("[roomId+timestamp]")
      .between([roomId, effectiveAfter], [roomId, Dexie.maxKey], false, true)
      .limit(limit)
      .toArray();
    return msgs;
  }

}
