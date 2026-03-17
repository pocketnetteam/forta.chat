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

    // Exclude soft-deleted messages, return in chronological order
    return msgs.filter((m) => !m.softDeleted).reverse();
  }

  /** Get a single message by server eventId */
  async getByEventId(eventId: string): Promise<LocalMessage | undefined> {
    return this.db.messages.where("eventId").equals(eventId).first();
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

    // Dedup: skip messages whose eventId already exists in DB
    if (eventIds.length > 0) {
      const existingEvents = await this.db.messages
        .where("eventId")
        .anyOf(eventIds)
        .toArray();
      const existingEventIds = new Set(existingEvents.map((e) => e.eventId));
      const filtered = messages.filter(
        (m) => !m.eventId || !existingEventIds.has(m.eventId),
      );
      if (filtered.length > 0) {
        await this.db.messages.bulkAdd(filtered);
      }
    } else {
      await this.db.messages.bulkAdd(messages);
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
    if (!target || target.softDeleted || target.roomId !== roomId) return null;

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

    const all = [...before.reverse(), target, ...after].filter(m => !m.softDeleted);
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
    return msgs.filter(m => !m.softDeleted);
  }
}
