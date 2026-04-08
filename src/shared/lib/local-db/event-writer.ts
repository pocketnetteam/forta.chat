import type { ChatDatabase, LocalMessage } from "./schema";
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
import { WriteBuffer, type BufferedWrite } from "./write-buffer";
import { perfMark, perfMeasure } from "@/shared/lib/perf-markers";
import { tRaw } from "@/shared/lib/i18n";
import type { LinkPreview } from "@/entities/chat/model/types";

const URL_RE = /https?:\/\/[^\s<>]+/;

/** Callback type for fetching OG link preview metadata */
export type FetchPreviewFn = (url: string) => Promise<LinkPreview | null>;

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
  /** Sender explicitly dismissed link preview — receiver should not generate one */
  noPreview?: boolean;
  deleted?: boolean;
  systemMeta?: { template: string; senderAddr: string; targetAddr?: string };
  /** Raw encrypted event JSON — stored for decryption retry when content is "[encrypted]" */
  encryptedRaw?: Record<string, unknown>;
  /** Reactions parsed from timeline — written to Dexie during bulk load */
  reactions?: Record<string, { count: number; users: string[]; myEventId?: string }>;
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
  editTs?: number;  // origin_server_ts of edit event — for out-of-order guard
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
  /** Timestamp of the read message — used to advance the outbound watermark */
  timestamp: number;
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

  /** In-memory cache: roomId → clearedAtTs (avoids Dexie read on every message) */
  private clearedAtTsCache = new Map<string, number>();

  /** Set the cleared-at timestamp for a room (called from chat-store on clear) */
  setClearedAtTs(roomId: string, ts: number): void {
    this.clearedAtTsCache.set(roomId, ts);
  }

  /** Get cached clearedAtTs for a room (sync — returns only what's in memory) */
  getClearedAtTs(roomId: string): number | undefined {
    return this.clearedAtTsCache.get(roomId);
  }

  /** Load clearedAtTs from Dexie for a room (on room open) */
  async loadClearedAtTs(roomId: string): Promise<number | undefined> {
    const ts = await this.roomRepo.getClearedAtTs(roomId);
    if (ts) this.clearedAtTsCache.set(roomId, ts);
    return ts;
  }

  constructor(
    private db: ChatDatabase,
    private messageRepo: MessageRepository,
    private roomRepo: RoomRepository,
    private userRepo: UserRepository,
    onChange?: OnChangeCallback,
    private fetchPreviewFn?: FetchPreviewFn,
  ) {
    this.onChange = onChange;
  }

  /** Set the callback invoked after a DB write */
  setOnChange(cb: OnChangeCallback): void {
    this.onChange = cb;
  }

  // ---------------------------------------------------------------------------
  // Batched writes
  // ---------------------------------------------------------------------------

  private writeBuffer: WriteBuffer | null = null;

  /**
   * Enable write batching. Creates an internal WriteBuffer that accumulates
   * messages and flushes them in a single Dexie transaction.
   */
  enableBatching(): void {
    this.disposeBuffer();
    this.writeBuffer = new WriteBuffer(
      (items) => this.flushBatch(items),
      { delayMs: 150, maxSize: 50 },
    );
  }

  /**
   * Enqueue a message for batched write. Falls back to writeMessage()
   * if batching is not enabled.
   */
  async writeMessageBuffered(
    parsed: ParsedMessage,
    myAddress: string,
    activeRoomId: string | null,
  ): Promise<void> {
    if (!this.writeBuffer) {
      await this.writeMessage(parsed, myAddress, activeRoomId);
      return;
    }

    const localMsg = this.toLocalMessage(parsed);
    this.writeBuffer.enqueue({
      roomId: parsed.roomId,
      localMsg,
      parsed,
      myAddress,
      activeRoomId,
    });
  }

  /** Force-flush the write buffer immediately. No-op if batching not enabled. */
  async flushWriteBuffer(): Promise<void> {
    await this.writeBuffer?.flushNow();
  }

  /** Flush remaining items and dispose the write buffer. */
  async disposeBuffer(): Promise<void> {
    if (this.writeBuffer) {
      await this.writeBuffer.dispose();
      this.writeBuffer = null;
    }
  }

  /**
   * Flush a batch of buffered writes in a single Dexie transaction.
   * Calls onChange() once per unique roomId (not per message).
   *
   * NOTE: Transaction scope must include all tables accessed by
   * upsertFromServer, ensureRoomExists, and updateRoomPreview.
   * Currently: messages + rooms.
   */
  private async flushBatch(items: BufferedWrite[]): Promise<void> {
    perfMark("flush-batch:start");
    const changedRooms = new Set<string>();

    await this.db.transaction("rw", [this.db.messages, this.db.rooms], async () => {
      for (const item of items) {
        try {
          const result = await this.messageRepo.upsertFromServer(item.localMsg, this.clearedAtTsCache.get(item.roomId));

          if (result === "inserted" || result === "updated") {
            await this.ensureRoomExists(item.roomId);
            await this.updateRoomPreview(item.parsed);
          }

          if (result === "inserted") {
            // NOTE: unreadCount is NOT incremented here. Matrix SDK's
            // getUnreadNotificationCount("total") is the single source of truth,
            // synced to Dexie via bulkSyncRooms during room refresh cycles.
            changedRooms.add(item.roomId);
          }
        } catch (err) {
          // Fault-tolerant: one corrupted message must not abort the entire batch.
          console.error("[EventWriter] flushBatch: failed to write message, skipping:", item.parsed.eventId, err);
        }
      }
    });

    perfMark("flush-batch:end");
    perfMeasure("flush-batch", "flush-batch:start", "flush-batch:end");

    // Apply stashed edits for newly inserted messages (outside the transaction)
    for (const item of items) {
      if (item.parsed.eventId && this.pendingEdits.has(item.parsed.eventId)) {
        await this.applyPendingEdit(item.parsed.eventId, item.roomId);
      }
    }

    // Notify once per unique room (outside the transaction)
    for (const roomId of changedRooms) {
      this.onChange?.(roomId);
    }
  }

  // ---------------------------------------------------------------------------
  // Messages
  // ---------------------------------------------------------------------------

  /**
   * Write a single incoming message to local DB.
   * Handles dedup (own echo via clientId, duplicate eventId).
   * Only increments unread for messages from OTHER users in NON-ACTIVE rooms.
   *
   * All writes (message upsert + room preview + unread increment) are wrapped
   * in a single Dexie transaction to prevent races with refreshRoomsImmediate.
   */
  async writeMessage(
    parsed: ParsedMessage,
    myAddress: string,
    activeRoomId: string | null,
  ): Promise<"inserted" | "updated" | "duplicate"> {
    const localMsg = this.toLocalMessage(parsed);
    const out = { result: "duplicate" as "inserted" | "updated" | "duplicate" };

    await this.db.transaction("rw", [this.db.messages, this.db.rooms], async () => {
      out.result = await this.messageRepo.upsertFromServer(localMsg, this.clearedAtTsCache.get(localMsg.roomId));

      if (out.result === "inserted" || out.result === "updated") {
        // Ensure room exists in Dexie before updating preview
        await this.ensureRoomExists(parsed.roomId);
        await this.updateRoomPreview(parsed);
      }

      // NOTE: unreadCount is NOT incremented here. Matrix SDK's
      // getUnreadNotificationCount("total") is the single source of truth,
      // synced to Dexie via bulkSyncRooms during room refresh cycles.
    });

    if (out.result === "inserted") {
      // Apply any edit that arrived before the base message
      if (parsed.eventId) {
        await this.applyPendingEdit(parsed.eventId, parsed.roomId);
      }
      this.onChange?.(parsed.roomId);

      // Async link preview for incoming messages — skip if sender dismissed preview.
      if (!parsed.linkPreview && !parsed.noPreview && parsed.type === MessageType.text && this.fetchPreviewFn) {
        const url = parsed.content.match(URL_RE)?.[0];
        if (url) {
          this.fetchAndStoreLinkPreview(url, localMsg);
        }
      }
    }

    return out.result;
  }

  /**
   * Write a batch of messages (e.g., from initial room load or pagination).
   * More efficient than calling writeMessage one by one.
   */
  async writeMessages(messages: ParsedMessage[]): Promise<void> {
    if (messages.length === 0) return;

    const localMessages = messages.map((m) => this.toLocalMessage(m));
    const roomId = localMessages[0]?.roomId;
    const clearedAtTs = roomId ? this.clearedAtTsCache.get(roomId) : undefined;
    await this.messageRepo.bulkInsert(localMessages, clearedAtTs);

    // Update room preview with the latest message (skip if all messages were before clear marker)
    const sorted = [...messages].sort((a, b) => b.timestamp - a.timestamp);
    const latest = sorted[0];
    if (latest && !(clearedAtTs && latest.timestamp <= clearedAtTs)) {
      await this.updateRoomPreview(latest);
    }

    // Apply any stashed edits for messages that just landed
    for (const m of messages) {
      if (m.eventId && this.pendingEdits.has(m.eventId)) {
        await this.applyPendingEdit(m.eventId, m.roomId);
      }
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

    // Cascade: update room preview if this is the last message (non-blocking)
    this.cascadeReactionToRoom(msg.roomId, reaction.targetEventId, {
      emoji: reaction.emoji,
      senderAddress: reaction.senderAddress,
      timestamp: Date.now(),
    }).catch(() => {});

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

    // Cascade: recalculate room reaction from remaining (non-blocking)
    const lastReaction = this.pickLastReaction(msg.reactions);
    this.cascadeReactionToRoom(msg.roomId, targetEventId, lastReaction).catch(() => {});

    this.onChange?.(msg.roomId);
  }

  // ---------------------------------------------------------------------------
  // Poll votes
  // ---------------------------------------------------------------------------

  /** Persist a poll vote to the local DB */
  async writePollVote(
    pollEventId: string,
    voterAddress: string,
    optionId: string,
    isMine: boolean,
  ): Promise<void> {
    const msg = await this.messageRepo.getByEventId(pollEventId);
    if (!msg?.pollInfo) return;

    const pollInfo = { ...msg.pollInfo, votes: { ...msg.pollInfo.votes } };

    // Remove previous vote by this voter
    for (const key of Object.keys(pollInfo.votes)) {
      pollInfo.votes[key] = pollInfo.votes[key].filter(v => v !== voterAddress);
    }

    // Add new vote
    if (!pollInfo.votes[optionId]) pollInfo.votes[optionId] = [];
    pollInfo.votes[optionId] = [...pollInfo.votes[optionId], voterAddress];

    if (isMine) {
      pollInfo.myVote = optionId;
    }

    await this.messageRepo.updatePollInfo(pollEventId, pollInfo);
    this.onChange?.(msg.roomId);
  }

  /** Persist poll end to the local DB */
  async writePollEnd(pollEventId: string, endedByAddress: string): Promise<void> {
    const msg = await this.messageRepo.getByEventId(pollEventId);
    if (!msg?.pollInfo) return;

    const pollInfo = { ...msg.pollInfo, ended: true, endedBy: endedByAddress };
    await this.messageRepo.updatePollInfo(pollEventId, pollInfo);
    this.onChange?.(msg.roomId);
  }

  // ---------------------------------------------------------------------------
  // Edits
  // ---------------------------------------------------------------------------

  /** Edits whose base message hasn't arrived yet (keyed by target eventId) */
  private pendingEdits = new Map<string, { roomId: string; edit: ParsedEdit; stashedAt: number }>();
  private static readonly PENDING_EDIT_TTL_MS = 5 * 60_000; // 5 minutes
  private static readonly PENDING_EDIT_MAX_SIZE = 200;

  /** Apply an edit to a message in the local DB, updating room preview if needed */
  async writeEdit(roomId: string, edit: ParsedEdit): Promise<void> {
    const exists = await this.db.messages
      .where("eventId")
      .equals(edit.targetEventId)
      .count();

    if (exists === 0) {
      // Base message not in Dexie yet — stash for later
      this.pendingEdits.set(edit.targetEventId, { roomId, edit, stashedAt: Date.now() });
      this.evictStalePendingEdits();
      return;
    }

    // Wrap edit + room preview in a single transaction to prevent races
    await this.db.transaction("rw", [this.db.messages, this.db.rooms], async () => {
      await this.messageRepo.editLocal(edit.targetEventId, edit.newContent, edit.editTs);

      // Update room preview if the edited message is the last one shown
      const room = await this.roomRepo.getRoom(roomId);
      if (room?.lastMessageEventId === edit.targetEventId) {
        await this.db.rooms.update(roomId, {
          lastMessagePreview: edit.newContent,
        });
      }
    });

    this.onChange?.(roomId);
  }

  /** Apply a stashed edit after its base message has been written */
  async applyPendingEdit(eventId: string, roomId: string): Promise<void> {
    const stashed = this.pendingEdits.get(eventId);
    if (!stashed) return;
    this.pendingEdits.delete(eventId);
    await this.writeEdit(roomId, stashed.edit);
  }

  /** Evict stale or overflow entries from the pending edits buffer */
  private evictStalePendingEdits(): void {
    const now = Date.now();
    for (const [key, entry] of this.pendingEdits) {
      if (now - entry.stashedAt > EventWriter.PENDING_EDIT_TTL_MS) {
        this.pendingEdits.delete(key);
      }
    }
    // Hard cap: drop oldest entries if over limit
    if (this.pendingEdits.size > EventWriter.PENDING_EDIT_MAX_SIZE) {
      const sorted = [...this.pendingEdits.entries()]
        .sort((a, b) => a[1].stashedAt - b[1].stashedAt);
      const toRemove = sorted.slice(0, sorted.length - EventWriter.PENDING_EDIT_MAX_SIZE);
      for (const [key] of toRemove) {
        this.pendingEdits.delete(key);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Redactions (deletions)
  // ---------------------------------------------------------------------------

  /** Mark a message as soft-deleted and update room preview if needed */
  async writeRedaction(redaction: ParsedRedaction): Promise<void> {
    await this.messageRepo.softDelete(redaction.redactedEventId);

    // Mark replyTo.deleted on messages referencing the redacted one in Dexie
    await this.messageRepo.markReplyDeleted(redaction.redactedEventId);

    // Always update room preview after deletion
    const clearedAtTs = this.clearedAtTsCache.get(redaction.roomId);
    const prevMsg = await this.messageRepo.getLastNonDeleted(redaction.roomId, clearedAtTs);
    if (prevMsg) {
      await this.updateRoomPreviewFromLocal(prevMsg);
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

  /** Update outbound read watermark for a room (someone read our message) */
  async writeReceipt(receipt: ParsedReceipt): Promise<void> {
    // Advance the outbound watermark — all our messages with ts <= receipt.timestamp
    // are now considered "read" (derived, no per-message update needed)
    await this.roomRepo.updateOutboundWatermark(receipt.roomId, receipt.timestamp);
    this.onChange?.(receipt.roomId);
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

  /** Increment unread count for a room (when message arrives in non-active room).
   *  Uses atomic modify() to prevent race with concurrent markAsRead(). */
  async incrementUnread(roomId: string): Promise<void> {
    await this.db.rooms.where("id").equals(roomId)
      .modify((room: import("./schema").LocalRoom) => { room.unreadCount++; });
  }

  /** Reset unread count (user opened the room) */
  async clearUnread(roomId: string): Promise<void> {
    await this.roomRepo.setUnreadCount(roomId, 0);
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /** Fire-and-forget: fetch OG preview for a URL and patch the Dexie record. */
  private fetchAndStoreLinkPreview(url: string, localMsg: LocalMessage): void {
    if (!this.fetchPreviewFn) return;
    this.fetchPreviewFn(url).then(preview => {
      if (!preview) return;
      const key = localMsg.eventId
        ? this.messageRepo.getByEventId(localMsg.eventId).then(m => m?.localId)
        : Promise.resolve(localMsg.localId);

      return key.then(localId => {
        if (!localId) return;
        return this.db.messages.update(localId, { linkPreview: preview });
      });
    }).catch(() => { /* preview fetch failed — non-critical */ });
  }

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
      reactions: parsed.reactions,
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
    if (type === MessageType.image) return tRaw("message.photo");
    if (type === MessageType.video) return tRaw("message.video");
    if (type === MessageType.audio) return tRaw("message.voiceMessage");
    if (type === MessageType.videoCircle) return tRaw("message.videoMessage");
    if (type === MessageType.file) return tRaw("message.file");
    if (type === MessageType.poll) return tRaw("message.poll");
    if (type === MessageType.transfer) return `${tRaw("message.transfer")} ${transferAmount ?? 0} PKOIN`;
    return content;
  }

  /** Update room metadata after a new message.
   *  Fault-tolerant: if preview generation fails for any reason (corrupt content,
   *  missing fields), falls back to a safe placeholder so the sidebar never shows
   *  an empty grey strip. */
  private async updateRoomPreview(parsed: ParsedMessage): Promise<void> {
    let preview: string;
    try {
      preview = this.getPreviewText(
        parsed.type,
        parsed.content,
        parsed.transferInfo?.amount,
      );
    } catch (err) {
      console.error("[EventWriter] getPreviewText failed, using fallback:", parsed.eventId, err);
      preview = "[message]";
    }

    // Encrypted message awaiting decryption: clear preview to trigger skeleton in sidebar.
    // DecryptionWorker will call updateRoomPreview again once decrypted.
    const isEncryptedPending = parsed.content === "[encrypted]" && parsed.encryptedRaw;
    if (isEncryptedPending) {
      preview = "";
    }

    // Guard: never store an empty/whitespace-only preview for NON-encrypted messages.
    if (!isEncryptedPending && (!preview || !preview.trim())) {
      preview = "[message]";
    }

    await this.roomRepo.updateLastMessage(
      parsed.roomId,
      preview,
      parsed.timestamp,
      parsed.senderId,
      parsed.type,
      parsed.eventId,
      parsed.callInfo,
      parsed.systemMeta,
    );

    // Set decryption status on room preview for encrypted messages
    if (isEncryptedPending) {
      await this.db.rooms.update(parsed.roomId, {
        lastMessageDecryptionStatus: "pending",
      });
    }
  }

  /** Update room preview from an existing LocalMessage (used after deletion).
   *  Same fault-tolerance as updateRoomPreview — never stores empty preview. */
  private async updateRoomPreviewFromLocal(msg: LocalMessage): Promise<void> {
    let preview: string;
    try {
      preview = this.getPreviewText(
        msg.type,
        msg.content,
        msg.transferInfo?.amount,
      );
    } catch (err) {
      console.error("[EventWriter] getPreviewText failed for local msg:", msg.eventId ?? msg.clientId, err);
      preview = "[message]";
    }

    if (!preview || !preview.trim()) {
      const isEncrypted = msg.decryptionStatus === "pending" || msg.decryptionStatus === "failed";
      preview = isEncrypted ? "[encrypted message]" : "[message]";
    }

    await this.roomRepo.updateLastMessage(
      msg.roomId,
      preview,
      msg.serverTs ?? msg.timestamp,
      msg.senderId,
      msg.type,
      msg.eventId ?? undefined,
      msg.callInfo,
      msg.systemMeta,
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

  /** Ensure a minimal room row exists in Dexie.
   *  When a message arrives before fullRoomRefresh has upserted the room,
   *  updateLastMessage / setUnreadCount would silently no-op. This creates
   *  a placeholder row so those writes succeed. refreshRoomsImmediate will
   *  later fill in metadata (name, avatar, members) via updateRoom. */
  private async ensureRoomExists(roomId: string): Promise<void> {
    const existing = await this.db.rooms.get(roomId);
    if (existing) return;
    await this.db.rooms.put({
      id: roomId,
      name: roomId,
      avatar: "",
      isGroup: false,
      members: [],
      membership: "join",
      unreadCount: 0,
      topic: "",
      updatedAt: Date.now(),
      syncedAt: 0,
      hasMoreHistory: true,
      lastReadInboundTs: 0,
      lastReadOutboundTs: 0,
      lastMessageReaction: null,
      isDeleted: false,
      deletedAt: null,
      deleteReason: null,
    });
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
