import Dexie, { type Table } from "dexie";
import type {
  MessageType,
  FileInfo,
  ReplyTo,
  PollInfo,
  TransferInfo,
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

    // Version 11: add searchCache table for user-directory search TTL cache
    this.version(11).stores({
      rooms: "id, updatedAt, membership, isDeleted",
      messages: "++localId, eventId, clientId, [roomId+timestamp], [roomId+status], senderId",
      users: "address, updatedAt",
      pendingOps: "++id, [roomId+createdAt], status",
      syncState: "key",
      attachments: "++id, messageLocalId, status",
      decryptionQueue: "++id, eventId, roomId, status, [status+nextAttemptAt]",
      listenedMessages: "messageId",
      // PK: query (lower-cased). Index: expiresAt (GC scan).
      searchCache: "&query, expiresAt",
    });
  }
}
