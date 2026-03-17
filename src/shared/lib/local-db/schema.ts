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
  | "send_transfer"
  | "send_read_receipt";

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
  topic?: string;
  updatedAt: number;             // timestamp of last activity

  // Preview (for room list)
  lastMessagePreview?: string;   // decrypted preview text
  lastMessageTimestamp?: number;
  lastMessageSenderId?: string;
  lastMessageType?: MessageType;

  // Sync metadata
  syncedAt: number;              // last sync from server
  paginationToken?: string;      // Matrix backwards pagination token
  hasMoreHistory: boolean;       // false = we reached the beginning
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
  };

  // Sync & decryption metadata
  encryptedBody?: string;        // Raw encrypted event JSON for decryption retry
  decryptionStatus?: "ok" | "pending" | "failed"; // Decryption outcome
  decryptionAttempts?: number;   // Number of decrypt attempts
  serverTs?: number;             // Original server timestamp
  version: number;               // Incremented on each local edit
  softDeleted: boolean;          // true = marked for deletion, pending sync
  deletedAt?: number;            // When soft-delete happened
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

/** Queued decryption retry job */
export interface DecryptionJob {
  id?: number;                   // Auto PK
  eventId: string;               // Matrix event ID → LocalMessage.eventId
  roomId: string;
  encryptedBody: string;         // JSON-serialized raw Matrix event content
  status: "pending" | "processing" | "failed" | "dead";
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
  }
}
