import type { ChatDatabase, LocalMessage, LocalMessageStatus } from "./schema";
import type { MessageRepository } from "./message-repository";
import type { RoomRepository } from "./room-repository";
import type { UserRepository } from "./user-repository";
import {
  MessageType,
  type FileInfo,
  type ReplyTo,
  type PollInfo,
  type TransferInfo,
} from "@/entities/chat/model/types";

// ---------------------------------------------------------------------------
// Types for parsed events coming from chat-store / Matrix SDK layer
// ---------------------------------------------------------------------------

/** A parsed message ready to be written to local DB */
export interface ParsedMessage {
  eventId: string;
  roomId: string;
  senderId: string;
  content: string;
  timestamp: number;
  type: MessageType;
  fileInfo?: FileInfo;
  replyTo?: ReplyTo;
  forwardedFrom?: { senderId: string; senderName?: string };
  callInfo?: { callType: "voice" | "video"; missed: boolean; duration?: number };
  pollInfo?: PollInfo;
  transferInfo?: TransferInfo;
  /** Present when the message is our own echo (matched by clientId) */
  clientId?: string;
  linkPreview?: import("@/entities/chat/model/types").LinkPreview;
  deleted?: boolean;
  systemMeta?: { template: string; senderAddr: string; targetAddr?: string };
  /** Raw encrypted event JSON — stored for decryption retry when content is "[encrypted]" */
  encryptedRaw?: Record<string, unknown>;
}

/** A parsed reaction event */
export interface ParsedReaction {
  eventId: string;       // ID of the reaction event itself
  targetEventId: string; // Message being reacted to
  emoji: string;
  senderAddress: string;
  isMine: boolean;       // true if this is our own reaction
}

/** A parsed edit event */
export interface ParsedEdit {
  targetEventId: string;
  newContent: string;
}

/** A parsed redaction (deletion) event */
export interface ParsedRedaction {
  redactedEventId: string;
  roomId: string;
}

/** A parsed read receipt */
export interface ParsedReceipt {
  eventId: string;
  readerAddress: string;
  roomId: string;
}

type OnChangeCallback = (roomId: string) => void;

// ---------------------------------------------------------------------------
// EventWriter — writes incoming Matrix events to local DB
// ---------------------------------------------------------------------------

/**
 * EventWriter handles the inbound path: server → local DB.
 *
 * It is called from the chat-store event handlers (handleTimelineEvent,
 * handleReceiptEvent, handleRedactionEvent) after events have been parsed
 * and decrypted. The EventWriter's job is purely DB writes + room metadata
 * updates.
 *
 * Future migration path:
 *   Phase 4 will move event parsing from chat-store into EventWriter,
 *   making it the single entry point for all inbound Matrix events.
 */
export class EventWriter {
  private onChange?: OnChangeCallback;

  constructor(
    private db: ChatDatabase,
    private messageRepo: MessageRepository,
    private roomRepo: RoomRepository,
    private userRepo: UserRepository,
    onChange?: OnChangeCallback,
  ) {
    this.onChange = onChange;
  }

  /** Set the callback invoked after a DB write */
  setOnChange(cb: OnChangeCallback): void {
    this.onChange = cb;
  }

  // ---------------------------------------------------------------------------
  // Messages
  // ---------------------------------------------------------------------------

  /**
   * Write a single incoming message to local DB.
   * Handles dedup (own echo via clientId, duplicate eventId).
   * Only increments unread for messages from OTHER users in NON-ACTIVE rooms.
   */
  async writeMessage(
    parsed: ParsedMessage,
    myAddress: string,
    activeRoomId: string | null,
  ): Promise<"inserted" | "updated" | "duplicate"> {
    const localMsg = this.toLocalMessage(parsed);
    const result = await this.messageRepo.upsertFromServer(localMsg);

    if (result === "inserted" || result === "updated") {
      await this.updateRoomPreview(parsed);
    }

    if (result === "inserted") {
      // New message = reset reaction preview (new lastMessage has no reactions yet)
      await this.roomRepo.updateLastMessageReaction(parsed.roomId, null);

      // Only increment unread for OTHER people's messages in NON-ACTIVE rooms
      if (parsed.senderId !== myAddress && parsed.roomId !== activeRoomId) {
        await this.incrementUnread(parsed.roomId);
      }
      this.onChange?.(parsed.roomId);
    }

    return result;
  }

  /**
   * Write a batch of messages (e.g., from initial room load or pagination).
   * More efficient than calling writeMessage one by one.
   */
  async writeMessages(messages: ParsedMessage[]): Promise<void> {
    if (messages.length === 0) return;

    const localMessages = messages.map((m) => this.toLocalMessage(m));
    await this.messageRepo.bulkInsert(localMessages);

    // Update room preview with the latest message
    const sorted = [...messages].sort((a, b) => b.timestamp - a.timestamp);
    const latest = sorted[0];
    if (latest) {
      await this.updateRoomPreview(latest);
    }
  }

  // ---------------------------------------------------------------------------
  // Reactions
  // ---------------------------------------------------------------------------

  /** Apply a reaction to a message in the local DB */
  async writeReaction(reaction: ParsedReaction): Promise<void> {
    const msg = await this.messageRepo.getByEventId(reaction.targetEventId);
    if (!msg) return;

    const reactions = msg.reactions ?? {};
    if (!reactions[reaction.emoji]) {
      reactions[reaction.emoji] = { count: 0, users: [] };
    }

    const data = reactions[reaction.emoji];
    if (!data.users.includes(reaction.senderAddress)) {
      data.users.push(reaction.senderAddress);
      data.count = data.users.length;
    }

    // Track our own reaction eventId for future removal
    if (reaction.isMine && reaction.eventId.startsWith("$")) {
      data.myEventId = reaction.eventId;
    }

    await this.messageRepo.updateReactions(reaction.targetEventId, reactions);

    // Cascade: update room preview if this is the last message
    await this.cascadeReactionToRoom(msg.roomId, reaction.targetEventId, {
      emoji: reaction.emoji,
      senderAddress: reaction.senderAddress,
      timestamp: Date.now(),
    });

    this.onChange?.(msg.roomId);
  }

  /** Remove a reaction (redaction of a reaction event) */
  async removeReaction(
    targetEventId: string,
    emoji: string,
    senderAddress: string,
  ): Promise<void> {
    const msg = await this.messageRepo.getByEventId(targetEventId);
    if (!msg?.reactions?.[emoji]) return;

    const data = msg.reactions[emoji];
    data.users = data.users.filter((u) => u !== senderAddress);
    data.count = data.users.length;

    if (data.count === 0) {
      delete msg.reactions[emoji];
    } else {
      // Clear myEventId if it was our reaction
      if (data.myEventId) {
        delete data.myEventId;
      }
    }

    await this.messageRepo.updateReactions(targetEventId, msg.reactions);

    // Cascade: recalculate room reaction from remaining
    const lastReaction = this.pickLastReaction(msg.reactions);
    await this.cascadeReactionToRoom(msg.roomId, targetEventId, lastReaction);

    this.onChange?.(msg.roomId);
  }

  // ---------------------------------------------------------------------------
  // Edits
  // ---------------------------------------------------------------------------

  /** Apply an edit to a message in the local DB */
  async writeEdit(roomId: string, edit: ParsedEdit): Promise<void> {
    await this.messageRepo.editLocal(edit.targetEventId, edit.newContent);
    this.onChange?.(roomId);
  }

  // ---------------------------------------------------------------------------
  // Redactions (deletions)
  // ---------------------------------------------------------------------------

  /** Mark a message as soft-deleted and update room preview if needed */
  async writeRedaction(redaction: ParsedRedaction): Promise<void> {
    console.log("[DELETE-DEBUG] writeRedaction called:", redaction);
    await this.messageRepo.softDelete(redaction.redactedEventId);

    // Always update room preview after deletion
    const prevMsg = await this.messageRepo.getLastNonDeleted(redaction.roomId);
    console.log("[DELETE-DEBUG] getLastNonDeleted result:", { roomId: redaction.roomId, prevMsgEventId: prevMsg?.eventId, prevMsgContent: prevMsg?.content?.slice(0, 30) });
    if (prevMsg) {
      await this.updateRoomPreviewFromLocal(prevMsg);
      console.log("[DELETE-DEBUG] updated room preview to previous message");
    } else {
      // All messages in room are deleted — show tombstone preview.
      // Use db.rooms.put-style update to handle rooms not yet in Dexie.
      const room = await this.roomRepo.getRoom(redaction.roomId);
      if (room) {
        await this.roomRepo.updateLastMessage(
          redaction.roomId,
          "🚫 Message deleted",
          room.updatedAt,
          room.lastMessageSenderId ?? "",
          room.lastMessageType,
        );
      }
    }

    this.onChange?.(redaction.roomId);
  }

  // ---------------------------------------------------------------------------
  // Read receipts
  // ---------------------------------------------------------------------------

  /** Update read status for a message */
  async writeReceipt(receipt: ParsedReceipt): Promise<void> {
    const msg = await this.messageRepo.getByEventId(receipt.eventId);
    if (!msg) return;

    // If this is someone reading our message, mark it as "read"
    if (msg.status === "synced" || msg.status === "delivered") {
      await this.messageRepo.updateStatus(
        { eventId: receipt.eventId },
        "read" as LocalMessageStatus,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Sync metadata
  // ---------------------------------------------------------------------------

  /** Store the Matrix sync token for delta sync on reconnect */
  async saveSyncToken(token: string): Promise<void> {
    await this.db.syncState.put({ key: "sync_token", value: token });
    await this.db.syncState.put({ key: "last_sync_at", value: Date.now() });
  }

  /** Get the stored sync token */
  async getSyncToken(): Promise<string | undefined> {
    const entry = await this.db.syncState.get("sync_token");
    return entry?.value as string | undefined;
  }

  /** Get the last sync timestamp */
  async getLastSyncAt(): Promise<number | undefined> {
    const entry = await this.db.syncState.get("last_sync_at");
    return entry?.value as number | undefined;
  }

  // ---------------------------------------------------------------------------
  // Room updates
  // ---------------------------------------------------------------------------

  /** Increment unread count for a room (when message arrives in non-active room) */
  async incrementUnread(roomId: string): Promise<void> {
    const room = await this.roomRepo.getRoom(roomId);
    if (room) {
      await this.roomRepo.setUnreadCount(roomId, room.unreadCount + 1);
    }
  }

  /** Reset unread count (user opened the room) */
  async clearUnread(roomId: string): Promise<void> {
    await this.roomRepo.setUnreadCount(roomId, 0);
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /** Convert a ParsedMessage to a LocalMessage for DB insertion */
  private toLocalMessage(parsed: ParsedMessage): LocalMessage {
    const isEncrypted = parsed.content === "[encrypted]" && parsed.encryptedRaw;
    return {
      eventId: parsed.eventId,
      clientId: parsed.clientId ?? `srv_${parsed.eventId}`,
      roomId: parsed.roomId,
      senderId: parsed.senderId,
      content: parsed.content,
      timestamp: parsed.timestamp,
      type: parsed.type,
      status: "synced",
      version: 1,
      softDeleted: false,
      serverTs: parsed.timestamp,
      fileInfo: parsed.fileInfo,
      replyTo: parsed.replyTo,
      forwardedFrom: parsed.forwardedFrom,
      callInfo: parsed.callInfo,
      pollInfo: parsed.pollInfo,
      transferInfo: parsed.transferInfo,
      linkPreview: parsed.linkPreview,
      deleted: parsed.deleted,
      systemMeta: parsed.systemMeta,
      // Decryption retry metadata
      encryptedBody: isEncrypted ? JSON.stringify(parsed.encryptedRaw) : undefined,
      decryptionStatus: isEncrypted ? "pending" : "ok",
    };
  }

  /** Generate preview text from message type and content */
  private getPreviewText(
    type: MessageType,
    content: string,
    transferAmount?: number,
  ): string {
    if (type === MessageType.image) return "📷 Photo";
    if (type === MessageType.video) return "🎬 Video";
    if (type === MessageType.audio) return "🎵 Audio";
    if (type === MessageType.file) return "📎 File";
    if (type === MessageType.poll) return "📊 Poll";
    if (type === MessageType.transfer) return `💰 ${transferAmount ?? 0} PKOIN`;
    return content;
  }

  /** Update room metadata after a new message */
  private async updateRoomPreview(parsed: ParsedMessage): Promise<void> {
    const preview = this.getPreviewText(
      parsed.type,
      parsed.content,
      parsed.transferInfo?.amount,
    );
    await this.roomRepo.updateLastMessage(
      parsed.roomId,
      preview,
      parsed.timestamp,
      parsed.senderId,
      parsed.type,
      parsed.eventId,
    );
  }

  /** Update room preview from an existing LocalMessage (used after deletion) */
  private async updateRoomPreviewFromLocal(msg: LocalMessage): Promise<void> {
    const preview = this.getPreviewText(
      msg.type,
      msg.content,
      msg.transferInfo?.amount,
    );
    await this.roomRepo.updateLastMessage(
      msg.roomId,
      preview,
      msg.serverTs ?? msg.timestamp,
      msg.senderId,
      msg.type,
      msg.eventId ?? undefined,
    );
  }

  /** Cascade reaction change to room preview if target is the last message */
  private async cascadeReactionToRoom(
    roomId: string,
    targetEventId: string,
    reaction: import("./schema").LocalRoom["lastMessageReaction"],
  ): Promise<void> {
    const room = await this.roomRepo.getRoom(roomId);
    if (!room || room.lastMessageEventId !== targetEventId) return;
    await this.roomRepo.updateLastMessageReaction(roomId, reaction);
  }

  /** Pick the most recent reaction from remaining reactions map */
  private pickLastReaction(
    reactions: LocalMessage["reactions"],
  ): import("./schema").LocalRoom["lastMessageReaction"] {
    if (!reactions) return null;
    for (const [emoji, data] of Object.entries(reactions)) {
      if (data.users.length > 0) {
        return {
          emoji,
          senderAddress: data.users[data.users.length - 1],
          timestamp: Date.now(),
        };
      }
    }
    return null;
  }
}
