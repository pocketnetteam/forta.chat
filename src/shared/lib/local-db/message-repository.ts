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
  ): Promise<LocalMessage[]> {
    const upper = beforeTimestamp ?? Dexie.maxKey;
    const msgs = await this.db.messages
      .where("[roomId+timestamp]")
      .between([roomId, Dexie.minKey], [roomId, upper], true, !beforeTimestamp)
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
  async getLastNonDeleted(roomId: string): Promise<LocalMessage | undefined> {
    const msgs = await this.db.messages
      .where("[roomId+timestamp]")
      .between([roomId, Dexie.minKey], [roomId, Dexie.maxKey])
      .reverse()
      .filter((m) => !m.softDeleted && !m.deleted)
      .limit(1)
      .toArray();
    return msgs[0];
  }

  // ---------------------------------------------------------------------------
  // Writes (local-first)
  // ---------------------------------------------------------------------------

  /** Create a new message locally (pending sync) */
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
  }): Promise<LocalMessage> {
    const clientId = crypto.randomUUID();
    const now = Date.now();

    const message: LocalMessage = {
      eventId: null,
      clientId,
      roomId: params.roomId,
      senderId: params.senderId,
      content: params.content,
      timestamp: now,
      type: params.type ?? MessageType.text,
      status: "pending",
      version: 1,
      softDeleted: false,
      replyTo: params.replyTo,
      forwardedFrom: params.forwardedFrom,
      transferInfo: params.transferInfo,
      pollInfo: params.pollInfo,
      fileInfo: params.fileInfo,
    };

    const localId = await this.db.messages.add(message);
    message.localId = localId as number;
    return message;
  }

  /** Insert or update a message from the server (incoming sync).
   *  Returns "inserted" | "updated" | "duplicate". */
  async upsertFromServer(msg: LocalMessage): Promise<"inserted" | "updated" | "duplicate"> {
    // 1. Check if this is our own message echo (match by clientId)
    if (msg.clientId) {
      const existing = await this.getByClientId(msg.clientId);
      if (existing) {
        await this.db.messages.update(existing.localId!, {
          eventId: msg.eventId,
          status: "synced",
          serverTs: msg.serverTs ?? msg.timestamp,
        });
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
  async bulkInsert(messages: LocalMessage[]): Promise<void> {
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
  ): Promise<{ messages: LocalMessage[]; anchorIndex: number }> {
    const [before, after] = await Promise.all([
      this.db.messages
        .where("[roomId+timestamp]")
        .between([roomId, Dexie.minKey], [roomId, timestamp], true, true)
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
  ): Promise<number> {
    return this.db.messages
      .where("[roomId+timestamp]")
      .between([roomId, afterTimestamp], [roomId, Dexie.maxKey], false, true)
      .filter(m => m.senderId !== excludeSenderId && !m.softDeleted)
      .count();
  }

  /** Get the last message at or before a timestamp. */
  async getLastMessageAtOrBefore(
    roomId: string,
    timestamp: number,
  ): Promise<LocalMessage | undefined> {
    const msgs = await this.db.messages
      .where("[roomId+timestamp]")
      .between([roomId, Dexie.minKey], [roomId, timestamp], true, true)
      .reverse()
      .limit(1)
      .toArray();
    return msgs[0];
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
  ): Promise<{ messages: LocalMessage[]; targetIndex: number } | null> {
    const target = await this.getByEventId(targetEventId);
    if (!target || target.roomId !== roomId) return null;

    const [before, after] = await Promise.all([
      this.db.messages
        .where("[roomId+timestamp]")
        .between([roomId, Dexie.minKey], [roomId, target.timestamp], true, false)
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
  ): Promise<LocalMessage[]> {
    const msgs = await this.db.messages
      .where("[roomId+timestamp]")
      .between([roomId, afterTimestamp], [roomId, Dexie.maxKey], false, true)
      .limit(limit)
      .toArray();
    return msgs;
  }
}
