# Local-First Architecture: Technical Design Document

## 1. Executive Summary

### Current state
The app uses a **server-first + cache** model:
- Matrix server is the source of truth
- Pinia stores hold data in memory (volatile)
- `chat-cache.ts` caches rooms/messages in IndexedDB for instant first paint
- `offline-queue.ts` queues only text messages in localStorage
- Optimistic updates exist only for message sending

### Target state
**Local-first** model:
- **IndexedDB (Dexie.js)** is the local source of truth
- All reads come from the local DB, never from the Matrix SDK directly
- All mutations write locally first, then sync in the background
- Full **operation queue** supports all mutation types (send, edit, react, delete, files)
- Works offline for hours — full history browsing, message creation
- On reconnect, replays pending operations and applies server deltas
- Multi-device conflicts resolved via Matrix's immutable event model (last-event-wins)

### Why Dexie.js
- Works in Browser, Electron, and Mobile WebView (Capacitor)
- Promise-based, typed, easy schema migrations
- Compound indexes, bulk operations, efficient range queries
- 30KB gzipped, battle-tested, MIT license
- Dexie.js v4 supports live queries (reactive) for Vue integration

---

## 2. Local Database Schema

### 2.1 Core Tables

```typescript
// src/shared/lib/local-db/schema.ts

import Dexie, { type Table } from "dexie";

/** Local-first chat database */
export class ChatDatabase extends Dexie {
  rooms!: Table<LocalRoom>;
  messages!: Table<LocalMessage>;
  users!: Table<LocalUser>;
  pendingOps!: Table<PendingOperation>;
  syncState!: Table<SyncState>;
  attachments!: Table<LocalAttachment>;

  constructor(userId: string) {
    super(`bastyon-chat-${userId}`);

    this.version(1).stores({
      // PK: Matrix room ID. Indexes: updatedAt for sorting, membership for filtering
      rooms: "id, updatedAt, membership",

      // PK: auto-incremented local ID. Indexes:
      //   [roomId+timestamp] — fast room timeline queries (compound index)
      //   eventId — unique server event ID lookup
      //   [roomId+status] — find pending messages per room
      //   senderId — search by sender
      rooms: "id, updatedAt, membership",
      messages: "++localId, eventId, [roomId+timestamp], [roomId+status], senderId",

      // PK: Bastyon address
      users: "address, updatedAt",

      // PK: auto-incremented. Indexes:
      //   [roomId+createdAt] — process per room in FIFO order
      //   status — find failed/pending ops
      pendingOps: "++id, [roomId+createdAt], status",

      // PK: key (e.g., "sync_token", "rooms_synced_at")
      syncState: "key",

      // PK: auto-incremented. Index by messageLocalId for lookup
      attachments: "++id, messageLocalId, status",
    });
  }
}
```

### 2.2 Table Interfaces

```typescript
// --- ROOMS ---
interface LocalRoom {
  id: string;                  // Matrix room ID (!abc:server.com)
  name: string;
  avatar?: string;             // mxc:// URL or __pocketnet__:address
  isGroup: boolean;
  members: string[];           // hex-encoded Bastyon addresses
  membership: "join" | "invite" | "leave";
  unreadCount: number;
  topic?: string;
  updatedAt: number;           // timestamp of last activity
  lastMessagePreview?: string; // decrypted preview for room list
  lastMessageTimestamp?: number;
  lastMessageSenderId?: string;

  // Sync metadata
  syncedAt: number;            // last time room was synced from server
  paginationToken?: string;    // Matrix pagination token for loading older messages
  hasMoreHistory: boolean;     // false when we've reached the beginning
}

// --- MESSAGES ---
interface LocalMessage {
  localId?: number;            // Auto-incremented PK (Dexie manages this)
  eventId: string | null;      // Matrix event_id (null for pending messages)
  clientId: string;            // Client-generated unique ID (for dedup)
  roomId: string;
  senderId: string;            // Bastyon address
  content: string;             // Decrypted text content
  timestamp: number;           // Server timestamp (or local for pending)

  type: MessageType;           // text, image, file, video, audio, system, poll, transfer
  status: LocalMessageStatus;  // pending, syncing, synced, failed, deleted

  // Optional typed content
  fileInfo?: FileInfo;
  replyTo?: ReplyTo;
  reactions?: Record<string, { count: number; users: string[]; myEventId?: string }>;
  edited?: boolean;
  forwardedFrom?: { senderId: string; senderName?: string };
  callInfo?: CallInfo;
  pollInfo?: PollInfo;
  transferInfo?: TransferInfo;

  // Sync metadata
  encryptedBody?: string;      // Raw encrypted body (for re-send on failure)
  serverTs?: number;           // Original server timestamp
  version: number;             // Incremented on each local edit (optimistic lock)
  softDeleted: boolean;        // true = marked for deletion, pending sync
  deletedAt?: number;          // When soft-delete happened
}

type LocalMessageStatus =
  | "pending"    // Created locally, not yet sent
  | "syncing"    // Currently being sent to server
  | "synced"     // Confirmed by server (has eventId)
  | "failed"     // Send failed (will retry)
  | "delivered"  // Read receipt from server
  | "read";      // Read by recipient

// --- USERS ---
interface LocalUser {
  address: string;             // PK: Bastyon address
  name: string;
  about?: string;
  image?: string;              // Avatar URL
  updatedAt: number;
  syncedAt: number;            // Last fetched from server
}

// --- PENDING OPERATIONS ---
interface PendingOperation {
  id?: number;                 // Auto PK
  type: OperationType;
  roomId: string;
  payload: unknown;            // Type-specific data (see below)
  status: "pending" | "syncing" | "failed";
  retries: number;
  maxRetries: number;
  createdAt: number;
  lastAttemptAt?: number;
  errorMessage?: string;
  clientId: string;            // Links to message.clientId for dedup
}

type OperationType =
  | "send_message"      // payload: { content, replyToId?, forwardedFrom? }
  | "send_file"         // payload: { fileInfo, caption? }
  | "edit_message"      // payload: { eventId, newContent }
  | "delete_message"    // payload: { eventId }
  | "send_reaction"     // payload: { eventId, emoji }
  | "remove_reaction"   // payload: { eventId, reactionEventId }
  | "send_poll"         // payload: { question, options }
  | "vote_poll"         // payload: { pollEventId, optionId }
  | "send_transfer"     // payload: { txId, amount, from, to, message? }
  | "send_read_receipt" // payload: { eventId }
  | "mark_typing";      // payload: { isTyping }

// --- SYNC STATE ---
interface SyncState {
  key: string;                 // PK: "sync_token", "last_sync_at", etc.
  value: string | number;
}

// --- ATTACHMENTS ---
interface LocalAttachment {
  id?: number;
  messageLocalId: number;      // FK to LocalMessage.localId
  fileName: string;
  mimeType: string;
  size: number;
  localBlob?: Blob;            // Local file data (before upload)
  remoteUrl?: string;          // mxc:// URL (after upload)
  encryptionSecrets?: unknown; // Pcrypto file encryption metadata
  status: "local" | "uploading" | "uploaded" | "failed";
  uploadProgress?: number;     // 0-100
}
```

### 2.3 Indexes Rationale

| Index | Purpose |
|-------|---------|
| `messages.[roomId+timestamp]` | Load room timeline sorted by time (primary query) |
| `messages.[roomId+status]` | Find pending/failed messages in a room |
| `messages.eventId` | Look up by server ID (for dedup, edits, reactions) |
| `messages.senderId` | Search messages by user |
| `pendingOps.[roomId+createdAt]` | Process ops per room in FIFO order |
| `pendingOps.status` | Find all failed/pending ops |
| `rooms.updatedAt` | Sort room list by recency |
| `rooms.membership` | Filter joined vs invited rooms |
| `attachments.messageLocalId` | Find attachments for a message |

---

## 3. Sync Model

### 3.1 Overview

Since the Matrix homeserver is external (no custom endpoints), synchronization relies entirely on the **Matrix Client-Server API**:

```
┌─────────────┐     Matrix Sync API      ┌─────────────────┐
│  Local DB   │ ◄─────────────────────── │  Matrix Server   │
│  (Dexie.js) │ ────────────────────────► │  (Homeserver)    │
│             │   sendEvent / redact      │                  │
└──────┬──────┘                           └─────────────────┘
       │
       │  Reactive reads
       ▼
┌─────────────┐
│  Pinia      │  ← Thin reactive layer (reads from DB)
│  (ViewModel)│
└──────┬──────┘
       │
       ▼
┌─────────────┐
│  Vue UI     │
└─────────────┘
```

### 3.2 Outbound: Client → Server

**All mutations go through the Pending Operations Queue:**

```
User action
  │
  ├─ 1. Write to local DB (messages table)
  ├─ 2. Create PendingOperation record
  ├─ 3. Update Pinia store (reactive UI)
  │
  └─ 4. SyncEngine picks up operation
       ├─ If online: process immediately
       └─ If offline: stays in queue until reconnect
```

**Processing pipeline:**

```typescript
class SyncEngine {
  private processing = false;
  private db: ChatDatabase;

  /** Start processing pending operations */
  async processQueue() {
    if (this.processing) return;
    this.processing = true;

    try {
      while (true) {
        const op = await this.db.pendingOps
          .where("status")
          .equals("pending")
          .sortBy("createdAt")
          .then(ops => ops[0]);

        if (!op) break;

        await this.db.pendingOps.update(op.id!, { status: "syncing" });

        try {
          await this.executeOperation(op);
          await this.db.pendingOps.delete(op.id!);
        } catch (e) {
          const retries = op.retries + 1;
          if (retries >= op.maxRetries) {
            await this.db.pendingOps.update(op.id!, {
              status: "failed",
              retries,
              errorMessage: String(e),
              lastAttemptAt: Date.now(),
            });
            // Update message status in DB
            await this.markMessageFailed(op);
          } else {
            await this.db.pendingOps.update(op.id!, {
              status: "pending",
              retries,
              lastAttemptAt: Date.now(),
            });
            // Exponential backoff
            await sleep(Math.min(1000 * 2 ** retries, 30000));
          }
        }
      }
    } finally {
      this.processing = false;
    }
  }

  private async executeOperation(op: PendingOperation) {
    switch (op.type) {
      case "send_message":
        return this.syncSendMessage(op);
      case "edit_message":
        return this.syncEditMessage(op);
      case "delete_message":
        return this.syncDeleteMessage(op);
      case "send_reaction":
        return this.syncSendReaction(op);
      // ... etc
    }
  }
}
```

**Operation-specific sync:**

```typescript
// Send message: encrypt → send → update local message with server eventId
async syncSendMessage(op: PendingOperation) {
  const payload = op.payload as { content: string; replyToId?: string };
  const roomCrypto = await this.getRoomCrypto(op.roomId);

  let serverEventId: string;
  if (roomCrypto?.canBeEncrypt()) {
    const encrypted = await roomCrypto.encryptEvent(payload.content);
    serverEventId = await matrixService.sendEncryptedText(op.roomId, encrypted);
  } else {
    serverEventId = await matrixService.sendText(op.roomId, payload.content);
  }

  // Update local message: pending → synced
  await this.db.messages
    .where("clientId")
    .equals(op.clientId)
    .modify({ eventId: serverEventId, status: "synced" });
}

// Edit message: encrypt new content → send m.replace event
async syncEditMessage(op: PendingOperation) {
  const { eventId, newContent } = op.payload as { eventId: string; newContent: string };
  // Matrix edit: send new event with m.relates_to.rel_type = "m.replace"
  await matrixService.sendEdit(op.roomId, eventId, newContent);
}

// Delete message: send redaction
async syncDeleteMessage(op: PendingOperation) {
  const { eventId } = op.payload as { eventId: string };
  await matrixService.redactEvent(op.roomId, eventId);
}
```

### 3.3 Inbound: Server → Client

**Matrix sync delivers events → write to local DB:**

```
Matrix SDK "Room.timeline" event
  │
  ├─ 1. Parse event (decrypt if needed)
  ├─ 2. Dedup check: does clientId or eventId already exist in DB?
  │     ├─ Yes, same clientId: update eventId + status (our own echo)
  │     └─ No: insert new message
  ├─ 3. Write to local DB (messages table)
  ├─ 4. Update room metadata (lastMessage, unreadCount)
  └─ 5. Notify Pinia store → Vue reactivity triggers UI update
```

**Delta sync (reconnection):**

The Matrix sync API handles deltas natively:
1. Store `next_batch` token in `syncState` table
2. On reconnect, Matrix SDK uses stored token to get only new events
3. The SDK's IndexedDB store already persists sync state
4. Our additional step: write new events to our local DB

```typescript
// On Matrix "sync" event (PREPARED or SYNCING state):
async handleSyncComplete(syncData: unknown) {
  // Store sync token for next session
  const nextBatch = matrixService.getSyncToken();
  await this.db.syncState.put({ key: "sync_token", value: nextBatch });
  await this.db.syncState.put({ key: "last_sync_at", value: Date.now() });
}
```

### 3.4 Network Conditions

**Offline:**
- All reads from local DB — no change
- Mutations create PendingOperations with status "pending"
- Messages shown with "pending" status indicator (clock icon)
- SyncEngine paused (no processing)

**Reconnection:**
1. Connectivity listener fires `online` event
2. Matrix SDK resumes sync (uses stored `next_batch` token)
3. SyncEngine starts processing pending queue (FIFO)
4. Incoming sync events written to local DB
5. UI updates reactively

**Flapping network:**
- SyncEngine has exponential backoff (1s → 2s → 4s → ... → 30s max)
- Failed operations stay in queue with retry counter
- After `maxRetries` (default: 5), operation marked as `failed`
- User can manually retry failed messages (tap failed indicator)
- Matrix SDK handles its own reconnection logic

---

## 4. Conflict Resolution

### 4.1 Strategy: Server-Authoritative + Immutable Events

Matrix's event model naturally avoids most conflicts:
- **Messages are immutable** — once sent, the event never changes
- **Edits** are new events with `m.relates_to.rel_type = "m.replace"`
- **Reactions** are separate `m.reaction` events
- **Deletions** are `m.room.redaction` events

This means there are no true "conflicting writes" to the same record. Instead, all operations are append-only events that the server orders.

**Resolution rule: Server event ordering is authoritative.**

### 4.2 Metadata for Conflict Handling

```typescript
// Per-message metadata:
{
  clientId: string;     // UUID generated on creation — idempotency key
  version: number;      // Local version counter (for optimistic UI)
  eventId: string;      // Server-assigned (null while pending)
  serverTs: number;     // Server timestamp (null while pending)
  status: string;       // pending → syncing → synced
}

// Per-device metadata (in syncState table):
{
  key: "device_id",     value: "ABCDEF123"   // Matrix device ID
  key: "sync_token",    value: "s1234_..."    // Matrix since token
  key: "last_sync_at",  value: 1709500000000  // Last successful sync
}
```

### 4.3 Conflict Scenarios

#### Scenario 1: Same message edited on two devices

```
Device A (offline): Edit msg "Hello" → "Hello World" (pending)
Device B (online):  Edit msg "Hello" → "Hello Everyone" (synced)

Timeline:
1. Device B's edit arrives at server first → new event E1 (m.replace)
2. Device A reconnects → sends its edit → new event E2 (m.replace)
3. Both devices receive both E1 and E2 via sync
4. Result: E2 (last edit) wins — this is correct Matrix behavior

Local DB handling:
- When E1 arrives on Device A: update message content from E1
- When E2 arrives: our own edit echo — update message content from E2
- Final state: "Hello World" (Device A's edit) on both devices
- Both edits are visible in edit history (if implemented)
```

#### Scenario 2: Delete on one device, edit on another

```
Device A (offline): Delete msg M1 (pending redaction)
Device B (online):  Edit msg M1 → "Updated" (synced)

Timeline:
1. Device B's edit arrives → event E1 (m.replace for M1)
2. Device A reconnects → sends redaction → event E2 (m.room.redaction for M1)
3. Server applies redaction — M1 is redacted
4. All devices see M1 as deleted

Local DB handling:
- softDeleted = true locally on Device A
- When reconnected: send redaction → server confirms
- Device B receives redaction event → mark M1 as softDeleted
- Edit E1 is effectively orphaned (refers to deleted message)
- Both devices show M1 as deleted — delete wins over edit
```

#### Scenario 3: Offline reactions

```
Device A (offline): React 👍 to msg M1 (pending)
Device B (online):  React ❤️ to msg M1 (synced)

Timeline:
1. Device B's reaction → event E1 (m.reaction)
2. Device A reconnects → sends 👍 → event E2 (m.reaction)
3. Both reactions exist — user has both 👍 and ❤️

Local DB handling:
- Device A shows optimistic 👍 locally
- On sync: E1 arrives → add ❤️ to reactions
- E2 confirmed → 👍 stays
- Note: in our app, a user can have only one reaction per message.
  If that's the rule, Device A should check if E1 has their own reaction
  and remove the pending 👍 before sending.
```

### 4.4 Deduplication

The `clientId` field prevents duplicate messages:

```typescript
async writeIncomingEvent(event: ParsedEvent) {
  // Check if this is an echo of our own pending message
  const existing = await this.db.messages
    .where("clientId")
    .equals(event.clientId)
    .first();

  if (existing) {
    // Our own message echo — update with server data
    await this.db.messages.update(existing.localId!, {
      eventId: event.eventId,
      status: "synced",
      serverTs: event.timestamp,
    });
    return;
  }

  // Check if eventId already exists (duplicate sync)
  if (event.eventId) {
    const byEventId = await this.db.messages
      .where("eventId")
      .equals(event.eventId)
      .first();
    if (byEventId) return; // Already have it
  }

  // New message from another user
  await this.db.messages.add(event);
}
```

---

## 5. Client Code Architecture

### 5.1 Layer Diagram

```
┌──────────────────────────────────────────────────┐
│                    Vue Components                 │
│  (ChatWindow, MessageBubble, RoomList, etc.)     │
├──────────────────────────────────────────────────┤
│              Pinia Stores (ViewModel)             │
│  chatStore, authStore — reactive state            │
│  Reads from Repository, subscribes to changes     │
├──────────────────────────────────────────────────┤
│                   Repository Layer                │
│  MessageRepository, RoomRepository                │
│  Abstracts DB access + sync orchestration         │
├──────────────┬───────────────────────────────────┤
│  Local DB    │        SyncEngine                  │
│  (Dexie.js)  │  Matrix SDK ↔ PendingOps queue    │
│  IndexedDB   │  Connectivity-aware processing     │
└──────────────┴───────────────────────────────────┘
```

### 5.2 Repository Pattern

```typescript
// src/shared/lib/local-db/message-repository.ts

export class MessageRepository {
  constructor(
    private db: ChatDatabase,
    private syncEngine: SyncEngine,
  ) {}

  /** Load messages for a room from local DB (paginated) */
  async getMessages(
    roomId: string,
    limit = 50,
    beforeTimestamp?: number,
  ): Promise<LocalMessage[]> {
    let query = this.db.messages
      .where("[roomId+timestamp]")
      .between(
        [roomId, Dexie.minKey],
        [roomId, beforeTimestamp ?? Dexie.maxKey],
        true,
        beforeTimestamp ? false : true,
      )
      .reverse(); // Newest first

    const messages = await query.limit(limit).toArray();
    return messages.reverse(); // Return in chronological order
  }

  /** Send a new message (local-first) */
  async sendMessage(
    roomId: string,
    content: string,
    replyToId?: string,
  ): Promise<LocalMessage> {
    const clientId = crypto.randomUUID();
    const now = Date.now();

    const message: LocalMessage = {
      eventId: null,
      clientId,
      roomId,
      senderId: authStore.address!,
      content,
      timestamp: now,
      type: MessageType.text,
      status: "pending",
      version: 1,
      softDeleted: false,
      replyTo: replyToId ? await this.getReplyTo(replyToId) : undefined,
    };

    // 1. Write to local DB
    const localId = await this.db.messages.add(message);
    message.localId = localId;

    // 2. Create pending operation
    await this.db.pendingOps.add({
      type: "send_message",
      roomId,
      payload: { content, replyToId },
      status: "pending",
      retries: 0,
      maxRetries: 5,
      createdAt: now,
      clientId,
    });

    // 3. Update room lastMessage
    await this.db.rooms.update(roomId, {
      lastMessagePreview: content.slice(0, 100),
      lastMessageTimestamp: now,
      lastMessageSenderId: authStore.address!,
      updatedAt: now,
    });

    // 4. Trigger sync engine
    this.syncEngine.processQueue();

    return message;
  }

  /** Edit a message (local-first) */
  async editMessage(eventId: string, newContent: string): Promise<void> {
    // 1. Update local DB
    await this.db.messages
      .where("eventId")
      .equals(eventId)
      .modify({
        content: newContent,
        edited: true,
        version: (msg: LocalMessage) => msg.version + 1,
      });

    // 2. Queue sync operation
    await this.db.pendingOps.add({
      type: "edit_message",
      roomId: await this.getRoomIdForEvent(eventId),
      payload: { eventId, newContent },
      status: "pending",
      retries: 0,
      maxRetries: 5,
      createdAt: Date.now(),
      clientId: crypto.randomUUID(),
    });

    this.syncEngine.processQueue();
  }

  /** Delete a message (soft-delete local, queue redaction) */
  async deleteMessage(eventId: string): Promise<void> {
    const now = Date.now();

    await this.db.messages
      .where("eventId")
      .equals(eventId)
      .modify({
        softDeleted: true,
        deletedAt: now,
        status: "pending",
      });

    await this.db.pendingOps.add({
      type: "delete_message",
      roomId: await this.getRoomIdForEvent(eventId),
      payload: { eventId },
      status: "pending",
      retries: 0,
      maxRetries: 3,
      createdAt: now,
      clientId: crypto.randomUUID(),
    });

    this.syncEngine.processQueue();
  }

  /** Toggle reaction (local-first) */
  async toggleReaction(eventId: string, emoji: string): Promise<void> {
    const msg = await this.db.messages
      .where("eventId")
      .equals(eventId)
      .first();
    if (!msg) return;

    const myAddress = authStore.address!;
    const reactions = msg.reactions ?? {};
    const existing = reactions[emoji];
    const alreadyReacted = existing?.users.includes(myAddress);

    if (alreadyReacted && existing?.myEventId) {
      // Remove reaction locally
      existing.users = existing.users.filter(u => u !== myAddress);
      existing.count--;
      if (existing.count <= 0) delete reactions[emoji];

      await this.db.messages.update(msg.localId!, { reactions });
      await this.db.pendingOps.add({
        type: "remove_reaction",
        roomId: msg.roomId,
        payload: { eventId, reactionEventId: existing.myEventId },
        status: "pending",
        retries: 0,
        maxRetries: 3,
        createdAt: Date.now(),
        clientId: crypto.randomUUID(),
      });
    } else {
      // Add reaction locally
      if (!reactions[emoji]) reactions[emoji] = { count: 0, users: [] };
      reactions[emoji].count++;
      reactions[emoji].users.push(myAddress);

      await this.db.messages.update(msg.localId!, { reactions });
      await this.db.pendingOps.add({
        type: "send_reaction",
        roomId: msg.roomId,
        payload: { eventId, emoji },
        status: "pending",
        retries: 0,
        maxRetries: 3,
        createdAt: Date.now(),
        clientId: crypto.randomUUID(),
      });
    }

    this.syncEngine.processQueue();
  }
}
```

### 5.3 Room Repository

```typescript
// src/shared/lib/local-db/room-repository.ts

export class RoomRepository {
  constructor(private db: ChatDatabase) {}

  /** Get all joined rooms sorted by last activity */
  async getRooms(): Promise<LocalRoom[]> {
    return this.db.rooms
      .where("membership")
      .equals("join")
      .reverse()
      .sortBy("updatedAt");
  }

  /** Get a single room */
  async getRoom(roomId: string): Promise<LocalRoom | undefined> {
    return this.db.rooms.get(roomId);
  }

  /** Upsert room from Matrix sync */
  async upsertRoom(room: LocalRoom): Promise<void> {
    await this.db.rooms.put(room);
  }

  /** Bulk upsert rooms (after full sync) */
  async bulkUpsertRooms(rooms: LocalRoom[]): Promise<void> {
    await this.db.rooms.bulkPut(rooms);
  }

  /** Update unread count */
  async setUnreadCount(roomId: string, count: number): Promise<void> {
    await this.db.rooms.update(roomId, { unreadCount: count });
  }
}
```

### 5.4 Pinia Store Changes

The Pinia store becomes a **thin reactive layer** that reads from the repository:

```typescript
// src/entities/chat/model/chat-store.ts (refactored)

export const useChatStore = defineStore("chat", () => {
  // Injected dependencies
  let messageRepo: MessageRepository;
  let roomRepo: RoomRepository;

  // Reactive state (mirrors DB for Vue reactivity)
  const rooms = ref<LocalRoom[]>([]);
  const activeRoomId = ref<string | null>(null);
  const messages = ref<Record<string, LocalMessage[]>>({});
  const typing = ref<Record<string, string[]>>({});

  /** Initialize from local DB (instant, no network) */
  const initFromLocalDB = async () => {
    rooms.value = await roomRepo.getRooms();
    roomsInitialized.value = rooms.value.length > 0;
  };

  /** Set active room and load messages from local DB */
  const setActiveRoom = async (roomId: string) => {
    activeRoomId.value = roomId;
    // Load from local DB first (instant)
    messages.value[roomId] = await messageRepo.getMessages(roomId, 50);
    // Then trigger background sync for latest
    syncEngine.syncRoomIfNeeded(roomId);
  };

  /** Send message (writes to DB + queue, returns immediately) */
  const sendMessage = async (content: string) => {
    if (!activeRoomId.value) return;
    const msg = await messageRepo.sendMessage(
      activeRoomId.value,
      content,
    );
    // Optimistic: add to reactive state immediately
    if (!messages.value[msg.roomId]) messages.value[msg.roomId] = [];
    messages.value[msg.roomId].push(msg);
  };

  /** Load more history (pagination from local DB + server) */
  const loadMoreMessages = async (roomId: string) => {
    const current = messages.value[roomId] ?? [];
    const oldest = current[0]?.timestamp;
    // Try local DB first
    const older = await messageRepo.getMessages(roomId, 25, oldest);
    if (older.length > 0) {
      messages.value[roomId] = [...older, ...current];
    }
    // If local DB exhausted, fetch from server
    if (older.length < 25) {
      await syncEngine.paginateRoom(roomId);
      const freshOlder = await messageRepo.getMessages(roomId, 25, oldest);
      messages.value[roomId] = [...freshOlder, ...current];
    }
  };

  // ... (other methods similarly refactored)
});
```

### 5.5 UI Status Indicators

```typescript
// Message status → UI mapping
const statusConfig: Record<LocalMessageStatus, { icon: string; class: string }> = {
  pending:   { icon: "clock",      class: "text-text-on-main-bg-color/50" },
  syncing:   { icon: "arrow-up",   class: "text-text-on-main-bg-color/50 animate-pulse" },
  synced:    { icon: "check",      class: "text-text-on-main-bg-color/70" },
  delivered: { icon: "check-check", class: "text-text-on-main-bg-color/70" },
  read:      { icon: "check-check", class: "text-color-bg-ac" },
  failed:    { icon: "alert",      class: "text-color-bad cursor-pointer" },
};
```

In `MessageBubble.vue`:
```html
<!-- Status indicator for own messages -->
<button
  v-if="isOwn && message.status === 'failed'"
  class="text-color-bad text-xs"
  @click="retryMessage(message)"
>
  {{ t("message.sendFailed") }} · {{ t("message.tapToRetry") }}
</button>
```

---

## 6. Server-Side Considerations

Since the Matrix homeserver is external and we can't modify it, this section describes how the existing Matrix API maps to our needs:

### 6.1 Matrix API Coverage

| Local-first need | Matrix API | Notes |
|---|---|---|
| Send message | `PUT /_matrix/client/v3/rooms/{roomId}/send/m.room.message/{txnId}` | txnId enables idempotent retries |
| Edit message | Same endpoint with `m.relates_to.rel_type = "m.replace"` | |
| Delete message | `PUT /_matrix/client/v3/rooms/{roomId}/redact/{eventId}/{txnId}` | |
| Send reaction | `PUT /_matrix/client/v3/rooms/{roomId}/send/m.reaction/{txnId}` | |
| Read receipt | `POST /_matrix/client/v3/rooms/{roomId}/read_markers` | |
| Delta sync | `GET /_matrix/client/v3/sync?since={next_batch}` | Built-in to SDK |
| Pagination | `GET /_matrix/client/v3/rooms/{roomId}/messages?from={token}&dir=b` | Via SDK scrollback |
| Upload file | `POST /_matrix/media/v3/upload` | Returns mxc:// URL |

### 6.2 Idempotency

Matrix's `txnId` parameter on `PUT /send` endpoints provides built-in idempotency:
- Use `clientId` from PendingOperation as `txnId`
- If the same `txnId` is sent twice, server returns the same `event_id`
- This makes retry-on-failure safe

### 6.3 Sync Token Persistence

The Matrix SDK already persists sync state in its own IndexedDB store (`matrix-js-sdk-v6:*`). Our additional persistence in the `syncState` table is for:
- Tracking per-room sync freshness (`roomId:last_synced_at`)
- Storing pagination tokens per room
- Detecting stale rooms that need refresh

### 6.4 Server Events (WebSocket)

Matrix sync is a long-poll HTTP request (not WebSocket). The SDK handles this:
- `pollTimeout: 60000` — 60s long-poll
- Events delivered via callbacks: `Room.timeline`, `Room.receipt`, etc.
- On network loss: SDK pauses, resumes on reconnect
- All incoming events → write to local DB → update Pinia

---

## 7. Encryption Integration

### 7.1 Pcrypto + Local DB

Messages are stored **decrypted** in the local DB:
- On receive: decrypt with Pcrypto → store decrypted text in `content`
- On send (offline): store plaintext in `content`, encrypt when syncing
- `encryptedBody` field stores the encrypted version for retry/re-send

```typescript
// SyncEngine: encrypt before sending
async syncSendMessage(op: PendingOperation) {
  const msg = await this.db.messages
    .where("clientId")
    .equals(op.clientId)
    .first();
  if (!msg) return;

  const roomCrypto = await this.getRoomCrypto(op.roomId);
  let content: Record<string, unknown>;

  if (roomCrypto?.canBeEncrypt()) {
    const encrypted = await roomCrypto.encryptEvent(msg.content);
    content = encrypted;
  } else {
    content = { msgtype: "m.text", body: msg.content };
  }

  const serverEventId = await matrixService.sendEncryptedText(op.roomId, content);

  await this.db.messages.update(msg.localId!, {
    eventId: serverEventId,
    status: "synced",
  });
}
```

### 7.2 Security: Encrypted Local Storage

**IndexedDB data is unencrypted by default.** Mitigation strategy:

1. **Electron**: Use `safeStorage` API to encrypt the DB key
2. **Browser**: Accept that localStorage/IndexedDB is accessible to same-origin scripts. This is the same trust model as Element Web (Matrix reference client)
3. **Mobile**: Use platform keychain for encryption keys, encrypt sensitive fields
4. **Private key**: Already stored in localStorage — same security boundary

**Optional enhancement** (future): Encrypt `content` field in IndexedDB with a key derived from the user's private key. Decrypt on read. This adds protection against physical device access but adds latency.

---

## 8. Migration Plan

### Phase 1: Foundation (Week 1-2)

**Goal**: Set up Dexie DB, Repository layer, and data flow — without breaking existing functionality.

```
Step 1.1: Add Dexie dependency
  npm install dexie

Step 1.2: Create database schema
  New file: src/shared/lib/local-db/schema.ts
  New file: src/shared/lib/local-db/index.ts

Step 1.3: Create Repository classes
  New file: src/shared/lib/local-db/message-repository.ts
  New file: src/shared/lib/local-db/room-repository.ts
  New file: src/shared/lib/local-db/user-repository.ts

Step 1.4: Create SyncEngine skeleton
  New file: src/shared/lib/local-db/sync-engine.ts
  - Replaces offline-queue.ts
  - Processes all operation types

Step 1.5: Database initialization in app startup
  Modify: src/entities/auth/model/stores.ts
  - Create ChatDatabase instance after login
  - Pass to repositories and sync engine

Step 1.6: Migrate existing chat-cache.ts to use new DB
  - chat-cache.ts functions delegate to Dexie tables
  - Old IndexedDB "bastyon-chat-cache" still works
  - Feature flag: LOCAL_FIRST_ENABLED (default: false)
```

### Phase 2: Read Path (Week 2-3)

**Goal**: All reads come from local DB.

```
Step 2.1: Room list from local DB
  - On app start: load rooms from Dexie (instant)
  - On Matrix sync: write to Dexie, then update Pinia

Step 2.2: Message loading from local DB
  - setActiveRoom: read from Dexie first
  - Background: fetch from Matrix, write to Dexie, diff with Pinia

Step 2.3: Pagination from local DB
  - loadMoreMessages: query Dexie first
  - If exhausted: scrollback Matrix → write to Dexie → query again

Step 2.4: User profiles from local DB
  - Cache user data in users table
  - Load from SDK only if stale (>1 hour)
```

### Phase 3: Write Path (Week 3-4)

**Goal**: All mutations go through local DB + operation queue.

```
Step 3.1: Replace sendMessage flow
  - Write to Dexie → queue PendingOp → SyncEngine sends
  - Remove direct matrixService.sendText calls from Pinia actions

Step 3.2: Replace editMessage flow
  - Update Dexie → queue PendingOp → SyncEngine sends edit

Step 3.3: Replace deleteMessage flow
  - Soft-delete in Dexie → queue PendingOp → SyncEngine sends redaction

Step 3.4: Replace reaction flow
  - Update reactions in Dexie → queue PendingOp → SyncEngine sends

Step 3.5: Replace file sending flow
  - Store file locally → queue upload + send message ops

Step 3.6: Migrate offline-queue.ts to PendingOps table
  - Support all operation types (not just text)
  - Exponential backoff on failures
  - Retry UI for failed messages
```

### Phase 4: Inbound Sync (Week 4-5)

**Goal**: All incoming Matrix events write to local DB first.

```
Step 4.1: Refactor handleTimelineEvent
  - Parse + decrypt event → write to Dexie → update Pinia from Dexie

Step 4.2: Deduplication
  - clientId-based dedup for own message echoes
  - eventId-based dedup for server events

Step 4.3: Conflict resolution
  - Handle edit events: update content in Dexie
  - Handle redaction events: soft-delete in Dexie
  - Handle reaction events: update reactions in Dexie

Step 4.4: Room sync
  - Matrix sync events → upsert rooms in Dexie → update Pinia
```

### Phase 5: Remove Old Code + Stabilize (Week 5-6)

```
Step 5.1: Remove chat-cache.ts (replaced by Dexie)
Step 5.2: Remove offline-queue.ts (replaced by PendingOps)
Step 5.3: Remove direct Matrix SDK calls from Pinia stores
Step 5.4: Clean up feature flags
Step 5.5: Migration for existing users:
  - On first load with new code: import data from old IndexedDB
  - Delete old "bastyon-chat-cache" database
Step 5.6: Performance testing
  - 10K+ messages per room
  - 100+ rooms
  - Offline → online transition with 50+ pending ops
```

### Parallel Support (Feature Flags)

During migration, use a feature flag to toggle between old and new:

```typescript
// src/shared/config/flags.ts
export const LOCAL_FIRST_ENABLED = import.meta.env.VITE_LOCAL_FIRST === "true";

// In chat-store.ts:
const sendMessage = async (content: string) => {
  if (LOCAL_FIRST_ENABLED) {
    return messageRepo.sendMessage(activeRoomId.value!, content);
  }
  // ... existing code
};
```

---

## 9. File Structure

```
src/shared/lib/local-db/
├── index.ts                    # Export DB instance, repos, engine
├── schema.ts                   # Dexie database class + table interfaces
├── message-repository.ts       # CRUD for messages table
├── room-repository.ts          # CRUD for rooms table
├── user-repository.ts          # CRUD for users table
├── attachment-repository.ts    # CRUD for attachments table
├── sync-engine.ts              # Pending ops processing + Matrix bridge
├── event-writer.ts             # Incoming Matrix events → local DB
└── migration.ts                # Migrate from old chat-cache.ts
```

---

## 10. Security & Privacy

### 10.1 Local Data Protection

| Concern | Mitigation |
|---------|------------|
| **Plaintext in IndexedDB** | Same-origin policy protects from other sites. Electron: use `safeStorage` for DB encryption key. Mobile: keychain-protected encryption. |
| **Private key in localStorage** | Already exists — not changing the threat model. Consider moving to Electron `safeStorage` or platform keychain. |
| **Message content searchable** | If needed, add field-level encryption using key derived from private key. Trade-off: no local search without decryption. |
| **GDPR right to erasure** | `deleteDatabase()` on logout. Add "Clear local data" button in settings. |
| **Device theft** | Rely on OS-level device encryption (FileVault, BitLocker, Android encryption). |
| **XSS attack** | Same-origin scripts can read IndexedDB. This is identical to current localStorage exposure. CSP headers mitigate XSS. |

### 10.2 Data Lifecycle

```
Login  → Create ChatDatabase (per-user, based on address)
Usage  → Read/write local DB, sync with Matrix
Logout → Delete ChatDatabase entirely (Dexie.delete())
         Clear localStorage auth data
         Clear Matrix SDK IndexedDB store
```

### 10.3 Multi-User on Same Device

Each user gets a separate Dexie database: `bastyon-chat-{userId}`.
No data leakage between users. Previous user's DB is deleted on logout.

---

## 11. Performance Considerations

### 11.1 Expected Volumes

| Metric | Expected | Index covers |
|--------|----------|-------------|
| Rooms per user | 50-500 | `rooms.membership` |
| Messages per room | 100-50,000 | `messages.[roomId+timestamp]` |
| Total messages | 5,000-500,000 | Compound indexes |
| Pending ops | 0-100 (burst) | `pendingOps.status` |
| Attachments | 0-1,000 | `attachments.messageLocalId` |

### 11.2 Optimization Strategies

1. **Lazy room loading**: Only load messages for active room
2. **Virtual scrolling**: Render only visible messages (already exists)
3. **Batch writes**: Group incoming sync events into bulk Dexie transactions
4. **Background sync**: Use `requestIdleCallback` for non-urgent DB writes
5. **Pagination size**: 50 messages per page, matching Matrix API default
6. **Cache eviction**: Messages older than 30 days can be pruned from local DB (re-fetched on demand from server)
7. **Dexie bulkPut**: Use bulk operations for initial sync (10x faster than individual puts)

### 11.3 Startup Performance

```
Current:    App loads → empty screen → Matrix sync → rooms appear (2-5s)
With cache: App loads → cached rooms (instant) → Matrix sync → delta update (100ms)
Local-first: App loads → full local data (instant) → background sync → deltas (0ms visible)
```

---

## 12. Testing Strategy

### 12.1 Unit Tests

- Repository CRUD operations (Dexie in-memory mode with `fake-indexeddb`)
- SyncEngine operation processing
- Conflict resolution scenarios
- Deduplication logic

### 12.2 Integration Tests

- Offline → create message → go online → verify sync
- Edit message on two "devices" → verify server ordering
- Delete + edit conflict → verify delete wins
- 100 pending ops → reconnect → all processed correctly

### 12.3 Manual Testing Checklist

- [ ] Fresh login: rooms load instantly from Matrix, cached for next time
- [ ] Page reload: rooms + messages appear instantly (no loading spinner)
- [ ] Send message offline: shows with clock icon, sends on reconnect
- [ ] Send 10 messages offline: all send in order on reconnect
- [ ] Edit message offline: shows edited locally, syncs on reconnect
- [ ] Delete message offline: disappears locally, syncs on reconnect
- [ ] React offline: shows locally, syncs on reconnect
- [ ] Failed message: shows retry button, tap to retry
- [ ] Large room (10K+ messages): pagination works smoothly
- [ ] Multi-tab: changes in one tab appear in another (via Dexie's `Observable`)
