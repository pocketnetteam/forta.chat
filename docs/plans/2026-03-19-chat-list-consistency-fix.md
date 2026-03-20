# Chat List Consistency Fix — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix broken chat list preview and unread badge by ensuring atomic Dexie transactions between `messages` and `rooms` tables.

**Architecture:** The sidebar reads exclusively from Dexie `rooms` table via liveQuery. Currently, `createLocal()` writes to `messages` but never updates `rooms`, and `EventWriter.writeMessage()` does message insert and room update as separate non-transactional operations. We wrap all writes in `db.transaction('rw', [messages, rooms])` and add room preview update to `createLocal()`.

**Tech Stack:** Dexie.js (IndexedDB), Vue 3 reactivity (liveQuery), TypeScript

---

### Task 1: Add room preview update to `MessageRepository.createLocal()`

**Why:** When user sends a message, `createLocal()` inserts into `messages` table but never touches `rooms`. The sidebar reads from `rooms.lastMessagePreview` — so the sent message never appears in the sidebar until a server echo (which is also broken).

**Files:**
- Modify: `src/shared/lib/local-db/message-repository.ts:77-112`

**Step 1: Add RoomRepository dependency**

The `MessageRepository` currently only has `db`. We need access to `RoomRepository` to update room preview. Add it as a constructor parameter.

In `src/shared/lib/local-db/message-repository.ts`, change the constructor:

```typescript
// OLD (line 6-7):
export class MessageRepository {
  constructor(private db: ChatDatabase) {}

// NEW:
export class MessageRepository {
  constructor(
    private db: ChatDatabase,
    private roomRepo?: import("./room-repository").RoomRepository,
  ) {}
```

Note: `roomRepo` is optional to avoid breaking existing instantiation until we wire it up.

**Step 2: Update `createLocal()` to atomically update room preview**

Replace `createLocal()` method (lines 77-112):

```typescript
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

    await this.db.transaction("rw", [this.db.messages, this.db.rooms], async () => {
      const localId = await this.db.messages.add(message);
      message.localId = localId as number;

      // Atomically update room preview so sidebar reflects sent message instantly
      const preview = this.getPreviewText(message);
      await this.db.rooms.update(params.roomId, {
        lastMessagePreview: preview.slice(0, 200),
        lastMessageTimestamp: now,
        lastMessageSenderId: params.senderId,
        lastMessageType: params.type ?? MessageType.text,
        lastMessageLocalStatus: "pending" as import("./schema").LocalMessageStatus,
        lastMessageReaction: null,
        updatedAt: now,
      });
    });

    return message;
  }

  /** Generate preview text for sidebar display */
  private getPreviewText(msg: LocalMessage): string {
    if (msg.type === MessageType.image) return "[photo]";
    if (msg.type === MessageType.video) return "[video]";
    if (msg.type === MessageType.audio) return "[voice message]";
    if (msg.type === MessageType.file) return "[file]";
    if (msg.type === MessageType.poll) return "[poll]";
    if (msg.type === MessageType.transfer) return `[transfer] ${msg.transferInfo?.amount ?? 0} PKOIN`;
    return msg.content;
  }
```

**Step 3: Wire RoomRepository into MessageRepository**

In `src/shared/lib/local-db/index.ts`, find where `MessageRepository` is instantiated and pass `roomRepo`:

Search for `new MessageRepository(` and change to `new MessageRepository(db, roomRepo)`.
The exact wiring depends on instantiation order — if `roomRepo` is created first, pass it directly. If not, create `roomRepo` first, then pass it.

**Step 4: Verify**

Run `npm run type-check` to confirm no TypeScript errors.

**Step 5: Commit**

```bash
git add src/shared/lib/local-db/message-repository.ts src/shared/lib/local-db/index.ts
git commit -m "fix: createLocal atomically updates room preview in sidebar"
```

---

### Task 2: Make `EventWriter.writeMessage()` atomic

**Why:** Currently message insert, room preview update, and unread increment are three separate Dexie operations. If any fails or races with `markAsRead()`, the sidebar gets inconsistent state.

**Files:**
- Modify: `src/shared/lib/local-db/event-writer.ts:117-138`

**Step 1: Wrap writeMessage in a single transaction**

Replace the `writeMessage` method (lines 117-138):

```typescript
  async writeMessage(
    parsed: ParsedMessage,
    myAddress: string,
    activeRoomId: string | null,
  ): Promise<"inserted" | "updated" | "duplicate"> {
    const localMsg = this.toLocalMessage(parsed);

    // All DB writes in a single atomic transaction:
    // message upsert + room preview + unread increment
    let result: "inserted" | "updated" | "duplicate" = "duplicate";

    await this.db.transaction("rw", [this.db.messages, this.db.rooms], async () => {
      result = await this.messageRepo.upsertFromServer(localMsg);

      if (result === "inserted" || result === "updated") {
        // Update room preview
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

      if (result === "inserted") {
        // Increment unread atomically (inside same transaction — no race with markAsRead)
        if (parsed.senderId !== myAddress && parsed.roomId !== activeRoomId) {
          const room = await this.roomRepo.getRoom(parsed.roomId);
          if (room) {
            await this.roomRepo.setUnreadCount(parsed.roomId, room.unreadCount + 1);
          }
        }
      }
    });

    if (result === "inserted") {
      this.onChange?.(parsed.roomId);
    }

    return result;
  }
```

**Step 2: Remove standalone `incrementUnread` calls**

The `incrementUnread` method (lines 307-313) is no longer needed for `writeMessage` since unread is now inside the transaction. Keep the method for external callers but mark it deprecated or leave as-is for `clearUnread`.

**Step 3: Verify**

Run `npm run type-check`.

**Step 4: Commit**

```bash
git add src/shared/lib/local-db/event-writer.ts
git commit -m "fix: atomic transaction for message insert + room preview + unread count"
```

---

### Task 3: Fix own-echo handler in chat-store

**Why:** When our own message echo comes back from the server, the handler at line 3285 passes `content: ""` to `dexieWriteMessage()`, which overwrites the room preview with empty string. Also, when pending messages exist, it does early return — skipping room preview update entirely.

**Files:**
- Modify: `src/entities/chat/model/chat-store.ts:3259-3298`

**Step 1: Fix the own-echo Dexie path**

Replace lines 3259-3298 with logic that doesn't corrupt the preview:

```typescript
      // Own-echo dedup: the bastyon Matrix SDK does NOT set
      // unsigned.transaction_id on echoes. Instead it emits local events
      // with ~!roomId:uuid format before the server assigns a real $eventId.
      // When Dexie is active, pending messages are in Dexie (not in-memory).
      // Skip ALL own echoes — confirmSent() handles the reconciliation.
      const matrixService = getMatrixClientService();
      const myUserId = matrixService.getUserId();
      if (myUserId && raw.sender === myUserId) {
        if (chatDbKitRef.value) {
          // Skip local SDK event IDs (~! prefix) — the real $ event will follow
          const eventId = raw.event_id as string;
          if (eventId.startsWith("~")) {
            return;
          }

          // Check if there are any pending/syncing messages in this room.
          // If yes, this echo is for one of them — skip entirely.
          // confirmSent() + createLocal() already updated the room preview.
          const pendingMsgs = await chatDbKitRef.value.messages.getPendingMessages(roomId);
          if (pendingMsgs.length > 0) {
            return;
          }

          // No pending messages — could be from another device or confirmSent
          // already ran. Let upsertFromServer handle dedup by eventId.
          // Write to Dexie with FULL content (not empty string).
          dexieWriteMessage(
            {
              id: eventId,
              roomId,
              senderId: matrixIdToAddress(raw.sender as string),
              content: body,  // ← Use parsed body, NOT empty string
              timestamp: (raw.origin_server_ts as number) ?? Date.now(),
              status: MessageStatus.sent,
              type: msgType,  // ← Use parsed message type
              fileInfo,       // ← Preserve file info if present
              replyTo,        // ← Preserve reply info if present
            },
            roomId,
            raw,
          );
          return;
        }
```

**Important:** The variables `body`, `msgType`, `fileInfo`, `replyTo` must be available at this point. Currently the own-echo check happens at line 3259, but `body` is parsed starting at line 3336. **The own-echo check must be moved AFTER content parsing**, or the content must be parsed before the check.

The simplest fix: move the own-echo block to AFTER the content has been parsed (after line ~3460, before the final `addMessage` call). Or, extract content parsing into a helper called before the echo check.

**Recommended approach:** Move the own-echo detection to just before the final `addMessage(roomId, message)` + `dexieWriteMessage(message, roomId, raw)` block at lines 3477-3478. At that point, the full `message` object is already built with correct content, type, fileInfo, etc.

Replace the own-echo block at 3259-3298 with just the `~!` prefix skip:

```typescript
      // Skip local SDK temporary event IDs (~! prefix) — the real $ event will follow
      const matrixService2 = getMatrixClientService();
      const myUserId2 = matrixService2.getUserId();
      if (myUserId2 && raw.sender === myUserId2 && chatDbKitRef.value) {
        const eventId = raw.event_id as string;
        if (eventId.startsWith("~")) {
          return;
        }
      }
```

Then, just before lines 3477-3478 (`addMessage` + `dexieWriteMessage`), add the full own-echo handling:

```typescript
      // Own-echo dedup for Dexie path
      if (myUserId && raw.sender === myUserId && chatDbKitRef.value) {
        const pendingMsgs = await chatDbKitRef.value.messages.getPendingMessages(roomId);
        if (pendingMsgs.length > 0) {
          // Echo for pending message — createLocal already updated room preview
          return;
        }
        // From another device or confirmSent already ran — write with full content
        dexieWriteMessage(message, roomId, raw);
        return;
      }

      addMessage(roomId, message);
      dexieWriteMessage(message, roomId, raw);
```

**Step 2: Verify**

Run `npm run type-check`.

**Step 3: Commit**

```bash
git add src/entities/chat/model/chat-store.ts
git commit -m "fix: own-echo handler preserves full message content for room preview"
```

---

### Task 4: Update room preview status after confirmSent

**Why:** After `SyncEngine.confirmSent()` updates message status to "synced", the room's `lastMessageLocalStatus` stays "pending". The sidebar should show the sent checkmark.

**Files:**
- Modify: `src/shared/lib/local-db/sync-engine.ts:150-199`

**Step 1: Update room status after confirmSent in `syncSendMessage`**

After line 198 (`await this.messageRepo.confirmSent(op.clientId, serverEventId);`), add:

```typescript
    // Update room preview status: pending → synced
    await this.roomRepo.updateRoom(op.roomId, {
      lastMessageLocalStatus: "synced" as import("./schema").LocalMessageStatus,
      lastMessageEventId: serverEventId,
    });
```

Do the same for `syncSendFile` (after line 251), `syncSendPoll` (after line 334), and `syncSendTransfer` (after line 381).

**Step 2: Verify**

Run `npm run type-check`.

**Step 3: Commit**

```bash
git add src/shared/lib/local-db/sync-engine.ts
git commit -m "fix: update room preview status to synced after confirmSent"
```

---

### Task 5: Final integration verification

**Step 1: Run full type check**

```bash
npm run type-check
```

**Step 2: Run lint**

```bash
npm run lint
```

**Step 3: Manual test scenarios**

1. **Send message → check sidebar preview updates immediately** (Naoki bug)
   - Open a chat, send "test message"
   - Sidebar should show "test message" as preview instantly
   - After server confirms, checkmark should appear

2. **Receive message in inactive chat → check unread badge** (Lisunset bug)
   - Be in chat A, receive message in chat B
   - Chat B should show unread badge (blue dot + count)
   - Preview text should update to new message

3. **Receive message in active chat → no unread badge**
   - Be in chat B, receive message in chat B
   - No unread badge should appear
   - Preview should update

4. **Cross-device message → preview updates**
   - Send message from another device
   - Sidebar should show the message preview (not empty string)

**Step 4: Commit all remaining changes**

```bash
git add -A
git commit -m "fix: chat list consistency — atomic transactions for preview and unread"
```
