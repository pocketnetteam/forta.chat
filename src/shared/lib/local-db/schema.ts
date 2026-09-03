import Dexie, { type Table } from "dexie";
import type {
  MessageType,
  FileInfo,
  ReplyTo,
  PollInfo,
  TransferInfo,
  CallLinkInfo,
  LinkPreview,
} from "@/entities/chat/model/types";

// ---------------------------------------------------------------------------
// Local-first message status (superset of MessageStatus from types.ts)
// ---------------------------------------------------------------------------

export type LocalMessageStatus =
  | "pending"   // Created locally, not yet sent to server
  | "syncing"   // Currently being sent
  | "synced"    // Server confirmed (has eventId)
  | "failed"    // Send failed (will retry or user taps retry)
  | "cancelled" // User cancelled upload — cleanup pending
  | "delivered" // Delivered to recipient
  | "read";     // Read by recipient

// ---------------------------------------------------------------------------
// Pending operation types
// ---------------------------------------------------------------------------

export type OperationType =
  | "send_message"
  | "send_file"
  | "edit_message"
  | "delete_message"
  | "send_reaction"
  | "remove_reaction"
  | "send_poll"
  | "vote_poll"
  | "send_transfer";

// ---------------------------------------------------------------------------
// Table interfaces
// ---------------------------------------------------------------------------

/** Local room — extends the conceptual ChatRoom with sync metadata */
export interface LocalRoom {
  id: string;                    // Matrix room ID (!abc:server.com)
  name: string;
  avatar?: string;               // mxc:// URL or __pocketnet__:address
  isGroup: boolean;
  members: string[];             // hex-encoded Bastyon addresses
  membership: "join" | "invite" | "leave";
  unreadCount: number;
  /** Watermark: timestamp of last inbound message WE have read (0 = unread) */
  lastReadInboundTs: number;
  /** Watermark: timestamp of our last outbound message the OTHER party has read (0 = unread) */
  lastReadOutboundTs: number;
  topic?: string;
  updatedAt: number;             // timestamp of last activity

  // Preview (for room list)
  lastMessagePreview?: string;   // decrypted preview text
  lastMessageTimestamp?: number;
  lastMessageSenderId?: string;
  lastMessageType?: MessageType;
  lastMessageEventId?: string;   // eventId of last message (for reaction cascade)
  lastMessageReaction?: {        // last reaction on the last message
    emoji: string;
    senderAddress: string;
    timestamp: number;
  } | null;
  /** Transport status of last message (pending/syncing/synced/failed — NOT read/delivered) */
  lastMessageLocalStatus?: LocalMessageStatus;
  /** Decryption status of last message preview */
  lastMessageDecryptionStatus?: "pending" | "failed";
  /** Call metadata for last message (if it was a call event) */
  lastMessageCallInfo?: { callType: "voice" | "video"; missed: boolean; duration?: number };
  /** System message metadata for last message (for i18n resolution in previews) */
  lastMessageSystemMeta?: { template: string; senderAddr: string; targetAddr?: string; extra?: Record<string, string> };

  // Tombstone (soft-delete for cross-device sync)
  isDeleted: boolean;            // true = user left/was kicked — hidden from UI
  deletedAt: number | null;      // when the deletion happened (ms)
  deleteReason: "left" | "kicked" | "banned" | "removed" | null;

  // Sync metadata
  syncedAt: number;              // last sync from server
  paginationToken?: string;      // Matrix backwards pagination token
  hasMoreHistory: boolean;       // false = we reached the beginning

  /** Timestamp (ms) when user cleared chat history. Events before this are hidden/purged. */
  clearedAtTs?: number;

  /** `m.room.history_visibility` content value; `"world_readable"` marks stream rooms (hidden from sidebar). */
  historyVisibility?: string | null;
}

/** Local message — extended with sync & local-first fields */
export interface LocalMessage {
  localId?: number;              // Auto-incremented PK (Dexie manages)
  eventId: string | null;        // Matrix event_id (null for pending)
  clientId: string;              // Client-generated UUID — idempotency key
  roomId: string;
  senderId: string;              // Bastyon address
  content: string;               // Decrypted text content
  timestamp: number;             // Server timestamp, or local time for pending

  type: MessageType;
  status: LocalMessageStatus;

  // Optional typed content (reuse existing interfaces)
  fileInfo?: FileInfo;
  replyTo?: ReplyTo;
  reactions?: Record<string, { count: number; users: string[]; myEventId?: string }>;
  edited?: boolean;
  forwardedFrom?: { senderId: string; senderName?: string };
  callInfo?: { callType: "voice" | "video"; missed: boolean; duration?: number };
  pollInfo?: PollInfo;
  transferInfo?: TransferInfo;
  callLinkInfo?: CallLinkInfo;   // External call-link card (WEE-57)
  linkPreview?: LinkPreview;
  deleted?: boolean;
  systemMeta?: {
    template: string;
    senderAddr: string;
    targetAddr?: string;
    extra?: Record<string, string>;
  };

  // Sync & decryption metadata
  encryptedBody?: string;        // Raw encrypted event JSON for decryption retry
  decryptionStatus?: "ok" | "pending" | "failed"; // Decryption outcome
  decryptionAttempts?: number;   // Number of decrypt attempts
  serverTs?: number;             // Original server timestamp
  version: number;               // Incremented on each local edit
  lastEditTs?: number;           // origin_server_ts of last applied edit (out-of-order guard)
  softDeleted: boolean;          // true = marked for deletion, pending sync
  deletedAt?: number;            // When soft-delete happened

  /** Upload progress 0-100 (only during media upload) */
  uploadProgress?: number;
  /** Current phase of media upload pipeline */
  uploadPhase?: "encrypting" | "uploading" | "sending_event";
  /** Local blob: URL for instant media preview before upload completes */
  localBlobUrl?: string;
}

/** Cached user profile */
export interface LocalUser {
  address: string;               // PK: Bastyon address
  name: string;
  about?: string;
  image?: string;                // Avatar URL
  updatedAt: number;
  syncedAt: number;              // Last fetched from server

  /** User-set local nickname (Telegram-style "rename contact").
   *  Visible only to the local user, synced across own devices via Matrix
   *  account_data ("m.bastyon.contact_aliases"). NEVER sent as Matrix
   *  room displayname — the peer must not see it. */
  localAlias?: string;
  /** Epoch-ms of the last `localAlias` change (LWW conflict resolution). */
  aliasUpdatedAt?: number;
}

/** Queued operation for sync */
export interface PendingOperation {
  id?: number;                   // Auto PK
  type: OperationType;
  roomId: string;
  payload: Record<string, unknown>;
  status: "pending" | "syncing" | "failed";
  retries: number;
  maxRetries: number;
  createdAt: number;
  lastAttemptAt?: number;
  errorMessage?: string;
  clientId: string;              // Links to LocalMessage.clientId for dedup
  /**
   * Epoch-ms at which this op becomes eligible for execution again.
   * 0 (or undefined) = due immediately. Used by the non-blocking
   * backoff scheduler so that a delayed op does not hold up the queue.
   */
  nextAttemptAt?: number;
}

/** Key-value store for sync metadata */
export interface SyncStateEntry {
  key: string;                   // PK: "sync_token", "last_sync_at", etc.
  value: string | number;
}

/** Local file/attachment before upload */
export interface LocalAttachment {
  id?: number;                   // Auto PK
  messageLocalId: number;        // FK → LocalMessage.localId
  fileName: string;
  mimeType: string;
  size: number;
  localBlob?: Blob;              // File data before upload
  remoteUrl?: string;            // mxc:// URL after upload
  encryptionSecrets?: Record<string, unknown>;
  status: "local" | "uploading" | "uploaded" | "failed";
  uploadProgress?: number;       // 0-100
}

/** Listened voice message marker (persisted locally) */
export interface ListenedMessage {
  messageId: string;               // PK: Matrix event ID or clientId
}

/** Cached user-directory search results (query → results with TTL) */
export interface SearchCacheRow {
  query: string;                   // PK: lower-cased search query
  results: Array<{ address: string; name: string; image?: string }>;
  expiresAt: number;               // Unix ms — entry is considered stale past this
}

// ---------------------------------------------------------------------------
// Channels (Bastyon broadcast subscriptions)
// ---------------------------------------------------------------------------

export interface ChannelLastContent {
  txid: string;
  type: "video" | "share" | "article";
  caption: string;
  message: string;
  time: number;
  height: number;
  scoreSum: number;
  scoreCnt: number;
  comments: number;
  images?: string[];
  url?: string;
  tags?: string[];
  settings?: { v?: string };
}

/** Persisted Bastyon channel subscription. Source of truth for cold-start render
 *  before the Pocketnet RPC `getsubscribeschannels` response arrives. */
export interface LocalChannel {
  address: string;                 // PK: channel author Bastyon address
  name: string;
  avatar: string;
  lastContent: ChannelLastContent | null;
  /** Preserves the order returned by Pocketnet RPC across cold-starts.
   *  Lower = higher in the list. Backfilled per fetch page. */
  syncOrder: number;
  /** Timestamp of the latest RPC refresh that touched this entry. */
  updatedAt: number;
}

/** Top-level grouping the Settings → Storage UI shows as tabs:
 *  Media (photos + videos), Files (PDFs/archives/docs), Voice (voice
 *  notes / audio). The category is computed from MessageType + mime at
 *  put-time and stored on the index row so the breakdown queries can
 *  group cheaply without re-classifying. */
export type MediaCacheCategory = "media" | "file" | "voice";

/** Persistent media cache index — Telegram/WhatsApp-style disk cache for
 *  decrypted media blobs. The bytes themselves live in `mediaCacheBlobs`
 *  (web) or Capacitor Filesystem (native) — this table only holds metadata
 *  + LRU bookkeeping. PK is the original `mxc://server/id` URI so cache
 *  lookups from `useFileDownload` are O(1) by primary key.
 *
 *  Added in v16: roomId / category / fileName so Settings → Storage can
 *  render a per-chat breakdown and per-category lists like Telegram does. */
export interface MediaCacheIndexEntry {
  mxc: string;                     // PK: mxc:// or https:// URL
  size: number;                    // Bytes of the cached blob
  mime: string;                    // Content-Type (e.g. image/jpeg)
  accessedAt: number;              // epoch-ms of last get() — LRU watermark
  createdAt: number;               // epoch-ms of first put — sort key
  roomId: string;                  // Matrix room ID this blob came from
  category: MediaCacheCategory;    // Top-level grouping for the Storage UI
  fileName?: string;               // Original filename (files/voice only)
}

/** Web-fallback storage row: the decrypted blob bytes themselves.
 *  PK matches `MediaCacheIndexEntry.mxc`. On native (Capacitor) the blob
 *  lives on disk and this table is unused. */
export interface MediaCacheBlobRow {
  mxc: string;                     // PK: mxc://server/mediaId
  blob: Blob;                      // Decrypted plaintext bytes
}

/** Queued decryption retry job */
export interface DecryptionJob {
  id?: number;                   // Auto PK
  eventId: string;               // Matrix event ID → LocalMessage.eventId
  roomId: string;
  encryptedBody: string;         // JSON-serialized raw Matrix event content
  status: "queued" | "processing" | "waiting" | "dead";
  attempts: number;
  nextAttemptAt: number;         // Timestamp for backoff scheduling
  lastError?: string;
  createdAt: number;
}

/**
 * A user-configured external meeting provider (WEE-57).
 *
 * Privacy: these rows live ONLY in the per-user local IndexedDB
 * (`bastyon-chat-{userId}`). They are NEVER written to Matrix account_data
 * or the Pocketnet backend — personal meeting-room URLs stay on-device.
 */
export interface CallProvider {
  id?: number;                   // Auto-incremented PK
  label: string;                 // "Личный Zoom" — any user-chosen name
  urlTemplate: string;           // "https://zoom.us/j/1234567890" — any meeting URL
}

// ---------------------------------------------------------------------------
// Local AI chats (`local-ai` Mode B — see docs/plans/llama2/2026-08-11-local-ai-integration-plan.md §3)
// ---------------------------------------------------------------------------

export type AiMessageStatus = "pending" | "streaming" | "complete" | "cancelled" | "error";

/** Dexie is the source of truth for AI-chat metadata shown in the sidebar;
 *  `local-ai`'s internal SQLite only mirrors the same rows (by `id`) to build
 *  prompts/session-cache — it never drives the UI directly (Mode B). */
export interface LocalAiChat {
  id: string;                 // UUID, generated locally; the same id is sent to local-ai.upsertChat()
  title: string;
  createdAt: number;
  updatedAt: number;
  lastMessagePreview?: string;
  lastMessageTimestamp?: number;
  /** local-ai manifest model id the chat history was built against — for UI/debug
   *  display only; local-ai itself always resolves the current model via its own
   *  ModelRegistry regardless of this field. */
  modelId?: string;
}

export interface LocalAiMessage {
  localId?: number;           // Dexie auto PK
  id: string;                 // UUID; the same id is sent as userMessageId/assistantMessageId
  chatId: string;             // FK -> LocalAiChat.id
  role: "user" | "assistant"; // system messages are never rendered, not stored in this table
  content: string;
  status: AiMessageStatus;
  createdAt: number;
  tokenCount?: number;
}

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

/** Local-first chat database (one instance per logged-in user) */
export class ChatDatabase extends Dexie {
  rooms!: Table<LocalRoom>;
  messages!: Table<LocalMessage>;
  users!: Table<LocalUser>;
  pendingOps!: Table<PendingOperation>;
  syncState!: Table<SyncStateEntry>;
  attachments!: Table<LocalAttachment>;
  decryptionQueue!: Table<DecryptionJob>;
  listenedMessages!: Table<ListenedMessage>;
  searchCache!: Table<SearchCacheRow>;
  channels!: Table<LocalChannel>;
  mediaCacheIndex!: Table<MediaCacheIndexEntry>;
  mediaCacheBlobs!: Table<MediaCacheBlobRow>;
  callProviders!: Table<CallProvider>;
  aiChats!: Table<LocalAiChat>;
  aiMessages!: Table<LocalAiMessage>;

  constructor(userId: string) {
    super(`bastyon-chat-${userId}`);

    this.version(1).stores({
      // PK: Matrix room ID. Indexes: updatedAt (sorting), membership (filtering)
      rooms: "id, updatedAt, membership",

      // PK: auto-incremented localId. Indexes:
      //   [roomId+timestamp]  — paginated timeline queries
      //   [roomId+status]     — find pending/failed per room
      //   eventId             — server event ID lookup (dedup, edits, reactions)
      //   clientId            — own message echo dedup
      //   senderId            — search by user
      messages: "++localId, eventId, clientId, [roomId+timestamp], [roomId+status], senderId",

      // PK: Bastyon address
      users: "address, updatedAt",

      // PK: auto-incremented. Indexes:
      //   [roomId+createdAt]  — FIFO per room
      //   status              — find pending/failed ops
      pendingOps: "++id, [roomId+createdAt], status",

      // PK: key name
      syncState: "key",

      // PK: auto-incremented. Index: messageLocalId (FK lookup)
      attachments: "++id, messageLocalId, status",
    });

    // Version 2: add decryption retry queue
    this.version(2).stores({
      // Existing tables — repeat schema (Dexie requires all stores in each version)
      rooms: "id, updatedAt, membership",
      messages: "++localId, eventId, clientId, [roomId+timestamp], [roomId+status], senderId",
      users: "address, updatedAt",
      pendingOps: "++id, [roomId+createdAt], status",
      syncState: "key",
      attachments: "++id, messageLocalId, status",
      // New table: decryption retry queue
      decryptionQueue: "++id, eventId, roomId, status, [status+nextAttemptAt]",
    });

    // Version 3: deduplicate messages created by clientId/txnId mismatch
    this.version(3).stores({
      rooms: "id, updatedAt, membership",
      messages: "++localId, eventId, clientId, [roomId+timestamp], [roomId+status], senderId",
      users: "address, updatedAt",
      pendingOps: "++id, [roomId+createdAt], status",
      syncState: "key",
      attachments: "++id, messageLocalId, status",
      decryptionQueue: "++id, eventId, roomId, status, [status+nextAttemptAt]",
    }).upgrade(async (tx) => {
      const messages = tx.table("messages");
      const allMsgs = await messages.toArray();

      // Group by eventId to find duplicates
      const byEventId = new Map<string, Array<{ localId: number; status: string }>>();
      for (const msg of allMsgs) {
        if (!msg.eventId) continue;
        const group = byEventId.get(msg.eventId);
        if (group) group.push({ localId: msg.localId, status: msg.status });
        else byEventId.set(msg.eventId, [{ localId: msg.localId, status: msg.status }]);
      }

      const toDelete: number[] = [];
      for (const [, group] of byEventId) {
        if (group.length <= 1) continue;
        // Keep the synced one, or first if none synced
        const keeper = group.find((m) => m.status === "synced") ?? group[0];
        for (const msg of group) {
          if (msg.localId !== keeper.localId) {
            toDelete.push(msg.localId);
          }
        }
      }

      // Remove orphaned pending messages older than 24h with no eventId
      const dayAgo = Date.now() - 86_400_000;
      for (const msg of allMsgs) {
        if (!msg.eventId && msg.status === "pending" && msg.timestamp < dayAgo) {
          toDelete.push(msg.localId);
        }
      }

      if (toDelete.length > 0) {
        await messages.bulkDelete(toDelete);
        console.log(`[ChatDB] Dedup migration: removed ${toDelete.length} duplicate/orphaned messages`);
      }
    });

    // Version 4: add read watermarks to rooms, backfill from message statuses
    this.version(4).stores({
      rooms: "id, updatedAt, membership",
      messages: "++localId, eventId, clientId, [roomId+timestamp], [roomId+status], senderId",
      users: "address, updatedAt",
      pendingOps: "++id, [roomId+createdAt], status",
      syncState: "key",
      attachments: "++id, messageLocalId, status",
      decryptionQueue: "++id, eventId, roomId, status, [status+nextAttemptAt]",
    }).upgrade(async (tx) => {
      const rooms = tx.table("rooms");
      const messages = tx.table("messages");

      const allRooms = await rooms.toArray();
      for (const room of allRooms) {
        // Backfill outbound watermark: find the latest "read" message we sent
        const readMsgs = await messages
          .where("[roomId+status]")
          .equals([room.id, "read"])
          .toArray();
        const latestRead = readMsgs.reduce(
          (max: number, m: any) => (m.timestamp > max ? m.timestamp : max),
          0,
        );

        await rooms.update(room.id, {
          lastReadInboundTs: 0,
          lastReadOutboundTs: latestRead,
        });
      }

      console.log(`[ChatDB] Watermark migration: backfilled ${allRooms.length} rooms`);
    });

    // Version 5: heal broken cross-device messages
    // Messages sent from another device of the same user were stored with
    // content="" and decryptionStatus="ok" due to a bug in own-echo suppression.
    // This migration marks them for re-decryption and fixes stale room previews.
    this.version(5).stores({
      rooms: "id, updatedAt, membership",
      messages: "++localId, eventId, clientId, [roomId+timestamp], [roomId+status], senderId",
      users: "address, updatedAt",
      pendingOps: "++id, [roomId+createdAt], status",
      syncState: "key",
      attachments: "++id, messageLocalId, status",
      decryptionQueue: "++id, eventId, roomId, status, [status+nextAttemptAt]",
    }).upgrade(async (tx) => {
      const messages = tx.table("messages");
      const rooms = tx.table("rooms");
      const decryptionQueue = tx.table("decryptionQueue");

      // Find messages with empty content that are "ok" (the broken cross-device ones)
      // These have: content="" OR content very short, decryptionStatus="ok",
      // status="synced", eventId starts with "$", no encryptedBody
      const allMsgs = await messages
        .filter((m: any) =>
          m.content === "" &&
          m.decryptionStatus === "ok" &&
          m.status === "synced" &&
          m.eventId &&
          m.eventId.startsWith("$") &&
          !m.softDeleted &&
          !m.encryptedBody &&
          !m.deleted &&  // Not edited-to-empty (redacted messages have deleted=true)
          m.type === "text"  // Only text messages — media/file always have content
        )
        .toArray();

      if (allMsgs.length > 0) {
        // Mark these messages for re-decryption by setting decryptionStatus to "pending"
        // The DecryptionWorker can't process them without encryptedBody,
        // but setting status="pending" + content="[encrypted]" signals the UI
        // that these need re-fetching. We also set a flag so the app knows to
        // re-fetch the raw event from the server.
        for (const msg of allMsgs) {
          await messages.update(msg.localId, {
            content: "[encrypted]",
            decryptionStatus: "pending",
          });
        }
        console.log(`[ChatDB] Cross-device heal: marked ${allMsgs.length} empty messages for re-decryption`);
      }

      // Fix stale room previews showing "" or "[encrypted]"
      const allRooms = await rooms.toArray();
      const affectedRoomIds = new Set<string>();
      for (const room of allRooms) {
        if (room.lastMessagePreview === "" ||
            room.lastMessagePreview === "[encrypted]") {
          // Find the latest non-deleted message with actual content
          const roomMsgs = await messages
            .where("[roomId+timestamp]")
            .between([room.id, 0], [room.id, Infinity])
            .reverse()
            .filter((m: any) => !m.softDeleted && m.content !== "" && m.content !== "[encrypted]")
            .limit(1)
            .toArray();

          if (roomMsgs.length > 0) {
            const latest = roomMsgs[0];
            let preview = latest.content;
            if (latest.type === "image") preview = "[photo]";
            else if (latest.type === "video") preview = "[video]";
            else if (latest.type === "audio") preview = "[voice message]";
            else if (latest.type === "file") preview = "[file]";
            else if (latest.type === "poll") preview = "[poll]";

            await rooms.update(room.id, {
              lastMessagePreview: preview.slice(0, 200),
              lastMessageTimestamp: latest.timestamp,
              lastMessageSenderId: latest.senderId,
            });
            affectedRoomIds.add(room.id);
          }
        }
      }
      if (affectedRoomIds.size > 0) {
        console.log(`[ChatDB] Cross-device heal: fixed previews for ${affectedRoomIds.size} rooms`);
      }
    });

    // Version 6: add tombstone fields for cross-device delete sync
    // Adds isDeleted index so room queries can efficiently filter out tombstoned rooms.
    // Migrates deletedRoomIds from localStorage into Dexie tombstones.
    this.version(6).stores({
      rooms: "id, updatedAt, membership, isDeleted",
      messages: "++localId, eventId, clientId, [roomId+timestamp], [roomId+status], senderId",
      users: "address, updatedAt",
      pendingOps: "++id, [roomId+createdAt], status",
      syncState: "key",
      attachments: "++id, messageLocalId, status",
      decryptionQueue: "++id, eventId, roomId, status, [status+nextAttemptAt]",
    }).upgrade(async (tx) => {
      const rooms = tx.table("rooms");

      // 1. Backfill all existing rooms with isDeleted = false
      await rooms.toCollection().modify((room: any) => {
        if (room.isDeleted === undefined) {
          room.isDeleted = false;
          room.deletedAt = null;
          room.deleteReason = null;
        }
      });

      // 2. Migrate deletedRoomIds from localStorage → Dexie tombstones
      try {
        const DELETED_ROOMS_KEY = "bastyon-chat-deleted-rooms";
        const stored = localStorage.getItem(DELETED_ROOMS_KEY);
        if (stored) {
          const ids: string[] = JSON.parse(stored);
          for (const roomId of ids) {
            const existing = await rooms.get(roomId);
            if (existing) {
              await rooms.update(roomId, {
                isDeleted: true,
                deletedAt: Date.now(),
                deleteReason: "removed" as const,
                membership: "leave" as const,
              });
            }
          }
          // Clean up localStorage — Dexie is now the source of truth
          localStorage.removeItem(DELETED_ROOMS_KEY);
          console.log(`[ChatDB] Tombstone migration: migrated ${ids.length} deleted rooms from localStorage`);
        }
      } catch (e) {
        console.warn("[ChatDB] Tombstone migration: failed to migrate localStorage", e);
      }

      console.log("[ChatDB] Tombstone migration v6 complete");
    });

    // Version 7: add uploadProgress and localBlobUrl to LocalMessage (no index changes)
    this.version(7).stores({
      rooms: "id, updatedAt, membership, isDeleted",
      messages: "++localId, eventId, clientId, [roomId+timestamp], [roomId+status], senderId",
      users: "address, updatedAt",
      pendingOps: "++id, [roomId+createdAt], status",
      syncState: "key",
      attachments: "++id, messageLocalId, status",
      decryptionQueue: "++id, eventId, roomId, status, [status+nextAttemptAt]",
    });

    // Version 8: add listenedMessages table for persisting voice message listened state
    this.version(8).stores({
      rooms: "id, updatedAt, membership, isDeleted",
      messages: "++localId, eventId, clientId, [roomId+timestamp], [roomId+status], senderId",
      users: "address, updatedAt",
      pendingOps: "++id, [roomId+createdAt], status",
      syncState: "key",
      attachments: "++id, messageLocalId, status",
      decryptionQueue: "++id, eventId, roomId, status, [status+nextAttemptAt]",
      listenedMessages: "messageId",
    });

    // Version 9: add clearedAtTs to LocalRoom (no index changes needed)
    this.version(9).stores({
      rooms: "id, updatedAt, membership, isDeleted",
      messages: "++localId, eventId, clientId, [roomId+timestamp], [roomId+status], senderId",
      users: "address, updatedAt",
      pendingOps: "++id, [roomId+createdAt], status",
      syncState: "key",
      attachments: "++id, messageLocalId, status",
      decryptionQueue: "++id, eventId, roomId, status, [status+nextAttemptAt]",
      listenedMessages: "messageId",
    });

    // Version 10: rename decryption statuses (pending→queued, failed→waiting)
    this.version(10).stores({
      rooms: "id, updatedAt, membership, isDeleted",
      messages: "++localId, eventId, clientId, [roomId+timestamp], [roomId+status], senderId",
      users: "address, updatedAt",
      pendingOps: "++id, [roomId+createdAt], status",
      syncState: "key",
      attachments: "++id, messageLocalId, status",
      decryptionQueue: "++id, eventId, roomId, status, [status+nextAttemptAt]",
      listenedMessages: "messageId",
    }).upgrade(tx => {
      return tx.table("decryptionQueue").toCollection().modify(job => {
        if (job.status === "pending") job.status = "queued";
        if (job.status === "failed") job.status = "waiting";
      });
    });

    // Version 11:
    //   - add searchCache table for user-directory search TTL cache
    //   - historyVisibility on rooms (stream = world_readable) — optional field,
    //     no index change, merged from master
    this.version(11).stores({
      rooms: "id, updatedAt, membership, isDeleted",
      messages: "++localId, eventId, clientId, [roomId+timestamp], [roomId+status], senderId",
      users: "address, updatedAt",
      pendingOps: "++id, [roomId+createdAt], status",
      syncState: "key",
      attachments: "++id, messageLocalId, status",
      decryptionQueue: "++id, eventId, roomId, status, [status+nextAttemptAt]",
      listenedMessages: "messageId",
      // PK: query (lower-cased) — first field in the schema string is the
      // primary key by default; no `&` prefix needed (that marks a unique
      // index on a non-PK field). Index: expiresAt (GC scan).
      searchCache: "query, expiresAt",
    });

    // Version 12: add clientId + [status+nextAttemptAt] index to pendingOps so
    // the non-blocking SyncEngine scheduler can query due ops in O(log n)
    // and so migrations can look up ops by clientId. Backfill nextAttemptAt=0
    // (immediately due) for all existing pendingOps.
    this.version(12).stores({
      rooms: "id, updatedAt, membership, isDeleted",
      messages: "++localId, eventId, clientId, [roomId+timestamp], [roomId+status], senderId",
      users: "address, updatedAt",
      pendingOps: "++id, [roomId+createdAt], status, clientId, [status+nextAttemptAt]",
      syncState: "key",
      attachments: "++id, messageLocalId, status",
      decryptionQueue: "++id, eventId, roomId, status, [status+nextAttemptAt]",
      listenedMessages: "messageId",
      searchCache: "query, expiresAt",
    }).upgrade(tx => {
      return tx.table("pendingOps").toCollection().modify(op => {
        if (op.nextAttemptAt === undefined) op.nextAttemptAt = 0;
      });
    });

    // Version 13: add aliasUpdatedAt index to users for fast LWW conflict
    // resolution when applying inbound m.bastyon.contact_aliases account_data.
    // The localAlias field itself is not indexed (read via getAllAliases scan).
    this.version(13).stores({
      rooms: "id, updatedAt, membership, isDeleted",
      messages: "++localId, eventId, clientId, [roomId+timestamp], [roomId+status], senderId",
      users: "address, updatedAt, aliasUpdatedAt",
      pendingOps: "++id, [roomId+createdAt], status, clientId, [status+nextAttemptAt]",
      syncState: "key",
      attachments: "++id, messageLocalId, status",
      decryptionQueue: "++id, eventId, roomId, status, [status+nextAttemptAt]",
      listenedMessages: "messageId",
      searchCache: "query, expiresAt",
    });

    // Version 14: add channels table. Bastyon broadcast subscriptions used to
    // live only in transient Pinia state, so a slow Pocketnet RPC response on
    // cold-start showed an empty sidebar — users reported it as data loss
    // (forta-bugs#736, #553, #762, #471, WEE-24). PK: channel address;
    // syncOrder index preserves RPC list order across restarts.
    this.version(14).stores({
      rooms: "id, updatedAt, membership, isDeleted",
      messages: "++localId, eventId, clientId, [roomId+timestamp], [roomId+status], senderId",
      users: "address, updatedAt, aliasUpdatedAt",
      pendingOps: "++id, [roomId+createdAt], status, clientId, [status+nextAttemptAt]",
      syncState: "key",
      attachments: "++id, messageLocalId, status",
      decryptionQueue: "++id, eventId, roomId, status, [status+nextAttemptAt]",
      listenedMessages: "messageId",
      searchCache: "query, expiresAt",
      channels: "address, syncOrder, updatedAt",
    });

    // Version 15: add persistent media cache (Telegram/WhatsApp-style).
    // Decrypted media blobs persist across chat re-opens / app restarts so
    // photos and videos no longer re-download on every visit (WEE-33).
    //   - mediaCacheIndex: metadata + LRU bookkeeping, queried by accessedAt
    //   - mediaCacheBlobs: web-fallback blob bytes (native uses Filesystem)
    this.version(15).stores({
      rooms: "id, updatedAt, membership, isDeleted",
      messages: "++localId, eventId, clientId, [roomId+timestamp], [roomId+status], senderId",
      users: "address, updatedAt, aliasUpdatedAt",
      pendingOps: "++id, [roomId+createdAt], status, clientId, [status+nextAttemptAt]",
      syncState: "key",
      attachments: "++id, messageLocalId, status",
      decryptionQueue: "++id, eventId, roomId, status, [status+nextAttemptAt]",
      listenedMessages: "messageId",
      searchCache: "query, expiresAt",
      channels: "address, syncOrder, updatedAt",
      mediaCacheIndex: "mxc, accessedAt",
      mediaCacheBlobs: "mxc",
    });

    // Version 16: enrich media cache index with roomId + category + fileName
    // so Settings → Storage can show Telegram-style per-chat breakdown and
    // per-category lists (WEE-33 follow-up). Old v15 rows lack these fields
    // and there is no way to back-fill them (the source Matrix events have
    // already been forgotten by the time the cache populated), so the
    // migration wipes the cache. Users lose at most a few hundred MB of
    // re-downloadable blobs; we gain a clean dataset for the new UI.
    this.version(16).stores({
      rooms: "id, updatedAt, membership, isDeleted",
      messages: "++localId, eventId, clientId, [roomId+timestamp], [roomId+status], senderId",
      users: "address, updatedAt, aliasUpdatedAt",
      pendingOps: "++id, [roomId+createdAt], status, clientId, [status+nextAttemptAt]",
      syncState: "key",
      attachments: "++id, messageLocalId, status",
      decryptionQueue: "++id, eventId, roomId, status, [status+nextAttemptAt]",
      listenedMessages: "messageId",
      searchCache: "query, expiresAt",
      channels: "address, syncOrder, updatedAt",
      // New indexes:
      //   roomId   — per-chat breakdown query (where(roomId).equals(x))
      //   category — per-tab list (where(category).equals("media"))
      mediaCacheIndex: "mxc, accessedAt, roomId, category",
      mediaCacheBlobs: "mxc",
    }).upgrade(async (tx) => {
      // Wipe v15 rows + blobs — they don't carry the new metadata.
      // Filesystem-backed entries on native (Capacitor `Directory.Cache`)
      // are NOT touched here; the next `MediaCacheRepository.clearAll`
      // (or `enforceLimit` once new puts come in) will surface them as
      // orphans and self-heal via the storage MISS path.
      try { await tx.table("mediaCacheIndex").clear(); } catch { /* ignore */ }
      try { await tx.table("mediaCacheBlobs").clear(); } catch { /* ignore */ }
      console.log("[ChatDB] Media cache v16 migration: wiped v15 index (no roomId)");
    });

    // Version 17: local-only external call providers (WEE-57). Stored here
    // (and never in Matrix account_data) so personal meeting-room URLs stay
    // on-device. PK-only — the list is a handful of rows, queried with a
    // plain toArray(), so no secondary index is needed.
    this.version(17).stores({
      rooms: "id, updatedAt, membership, isDeleted",
      messages: "++localId, eventId, clientId, [roomId+timestamp], [roomId+status], senderId",
      users: "address, updatedAt, aliasUpdatedAt",
      pendingOps: "++id, [roomId+createdAt], status, clientId, [status+nextAttemptAt]",
      syncState: "key",
      attachments: "++id, messageLocalId, status",
      decryptionQueue: "++id, eventId, roomId, status, [status+nextAttemptAt]",
      listenedMessages: "messageId",
      searchCache: "query, expiresAt",
      channels: "address, syncOrder, updatedAt",
      mediaCacheIndex: "mxc, accessedAt, roomId, category",
      mediaCacheBlobs: "mxc",
      callProviders: "++id",
    });

    // Version 18: add aiChats/aiMessages tables for local AI chats (`local-ai`
    // library integration, Mode B — Dexie stays the source of truth, local-ai's
    // internal SQLite only mirrors these rows to build prompts/session-cache).
    // Not part of the Matrix/SyncEngine pipeline — no PendingOperation, no
    // encryption, no event-writer involvement. See
    // docs/plans/llama2/2026-08-11-local-ai-integration-plan.md §3.
    this.version(18).stores({
      rooms: "id, updatedAt, membership, isDeleted",
      messages: "++localId, eventId, clientId, [roomId+timestamp], [roomId+status], senderId",
      users: "address, updatedAt, aliasUpdatedAt",
      pendingOps: "++id, [roomId+createdAt], status, clientId, [status+nextAttemptAt]",
      syncState: "key",
      attachments: "++id, messageLocalId, status",
      decryptionQueue: "++id, eventId, roomId, status, [status+nextAttemptAt]",
      listenedMessages: "messageId",
      searchCache: "query, expiresAt",
      channels: "address, syncOrder, updatedAt",
      mediaCacheIndex: "mxc, accessedAt, roomId, category",
      mediaCacheBlobs: "mxc",
      callProviders: "++id",
      // PK: id. Index: updatedAt (sidebar sort, most-recent-first).
      aiChats: "id, updatedAt",
      // PK: auto-incremented localId. Indexes:
      //   id             — dedup/lookup by the id shared with local-ai
      //   [chatId+createdAt] — paginated per-chat timeline queries
      aiMessages: "++localId, id, [chatId+createdAt]",
    });

    // Version 19: re-queue group messages permanently stuck "[encrypted]"
    // because of the aeskeys cache-collision bug (matrix-crypto.ts —
    // eaa.aeskeys was memoized under a cache key that ignored the actual
    // resolved member set for group chats, so a stale AES key could get
    // reused for the rest of a room's session and every send/decrypt after
    // the first would derive the wrong key). Those messages exhausted
    // MAX_ATTEMPTS and reached the terminal decryptionStatus "failed",
    // which the normal boot/room-open recovery sweeps deliberately never
    // resurrect (to avoid retrying genuinely-undecryptable content forever
    // — see DecryptionWorker.recoverAllStuckMessages). Since the cache bug
    // is fixed, give them exactly one more chance by resetting them back to
    // "pending" so the existing recovery machinery picks them up normally.
    this.version(19).stores({
      rooms: "id, updatedAt, membership, isDeleted",
      messages: "++localId, eventId, clientId, [roomId+timestamp], [roomId+status], senderId",
      users: "address, updatedAt, aliasUpdatedAt",
      pendingOps: "++id, [roomId+createdAt], status, clientId, [status+nextAttemptAt]",
      syncState: "key",
      attachments: "++id, messageLocalId, status",
      decryptionQueue: "++id, eventId, roomId, status, [status+nextAttemptAt]",
      listenedMessages: "messageId",
      searchCache: "query, expiresAt",
      channels: "address, syncOrder, updatedAt",
      mediaCacheIndex: "mxc, accessedAt, roomId, category",
      mediaCacheBlobs: "mxc",
      callProviders: "++id",
      aiChats: "id, updatedAt",
      aiMessages: "++localId, id, [chatId+createdAt]",
    }).upgrade(async (tx) => {
      const messages = tx.table("messages");
      const rooms = tx.table("rooms");

      const deadMsgs = await messages
        .filter((m: any) =>
          m.decryptionStatus === "failed" &&
          !!m.encryptedBody &&
          !m.softDeleted &&
          !m.deleted
        )
        .toArray();

      if (deadMsgs.length > 0) {
        for (const msg of deadMsgs) {
          await messages.update(msg.localId, { decryptionStatus: "pending" });
        }
        console.log(`[ChatDB] aeskeys-cache heal: re-queued ${deadMsgs.length} permanently-failed message(s) for re-decryption`);
      }

      // Clear the terminal room-preview flag so the sidebar re-decrypts the
      // preview instead of staying pinned on the old "failed" placeholder.
      const affectedRoomIds = new Set(deadMsgs.map((m: any) => m.roomId));
      for (const roomId of affectedRoomIds) {
        const room = await rooms.get(roomId);
        if (room?.lastMessageDecryptionStatus === "failed") {
          await rooms.update(roomId, { lastMessageDecryptionStatus: undefined });
        }
      }
    });
  }
}
