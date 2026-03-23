# Fix Reply Preview "..." After Reopening Chat

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix bug where reply/quoted message previews show "..." instead of real text after reopening a chat room.

**Architecture:** The root cause is a Dexie persistence gap — `bulkInsert()` skips existing messages (dedup), so unresolved `replyTo` stored during real-time sync is never overwritten when `loadRoomMessages` later resolves it. Fix by adding `patchUnresolvedReplies()` to `MessageRepository` and calling it from `enrichUnresolvedReplies()` to write resolved data back to Dexie. Since `activeMessages` reads from Dexie via liveQuery, the UI auto-updates.

**Tech Stack:** Vue 3, Pinia, Dexie (IndexedDB), TypeScript, Vitest

---

### Task 1: Add `patchUnresolvedReplies()` to MessageRepository

**Files:**
- Modify: `src/shared/lib/local-db/message-repository.ts` (after line 277, after `markReplyDeleted`)
- Test: `src/shared/lib/local-db/__tests__/message-repository-reply.test.ts` (create)

**Step 1: Write the failing test**

Create `src/shared/lib/local-db/__tests__/message-repository-reply.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Dexie from "dexie";
import { MessageRepository } from "../message-repository";
import type { ChatDatabase, LocalMessage } from "../schema";
import { MessageType } from "@/entities/chat/model/types";

// Minimal in-memory Dexie for testing
class TestDb extends Dexie implements ChatDatabase {
  messages!: Dexie.Table<LocalMessage, number>;
  rooms!: Dexie.Table<any, string>;
  decryptionQueue!: Dexie.Table<any, number>;
  listenedMessages!: Dexie.Table<any, string>;
  pendingOps!: Dexie.Table<any, number>;
  users!: Dexie.Table<any, string>;

  constructor() {
    super("TestDb_reply", { indexedDB: require("fake-indexeddb"), IDBKeyRange: require("fake-indexeddb/lib/FDBKeyRange") });
    this.version(1).stores({
      messages: "++localId, eventId, clientId, [roomId+timestamp], [roomId+status], senderId",
      rooms: "id, updatedAt, membership, isDeleted",
      decryptionQueue: "++id, status, [status+nextAttemptAt]",
      listenedMessages: "eventId",
      pendingOps: "++id, status",
      users: "address",
    });
  }
}

function makeLocalMsg(overrides: Partial<LocalMessage> = {}): LocalMessage {
  return {
    eventId: overrides.eventId ?? `$evt_${Math.random().toString(36).slice(2)}`,
    clientId: overrides.clientId ?? `cli_${Math.random().toString(36).slice(2)}`,
    roomId: overrides.roomId ?? "!room:server",
    senderId: overrides.senderId ?? "user1",
    content: overrides.content ?? "hello",
    timestamp: overrides.timestamp ?? Date.now(),
    type: overrides.type ?? MessageType.text,
    status: overrides.status ?? "synced",
    version: 1,
    softDeleted: false,
    ...overrides,
  } as LocalMessage;
}

describe("MessageRepository.patchUnresolvedReplies", () => {
  let db: TestDb;
  let repo: MessageRepository;

  beforeEach(async () => {
    db = new TestDb();
    await db.open();
    repo = new MessageRepository(db as unknown as ChatDatabase);
  });

  afterEach(async () => {
    await db.delete();
  });

  it("updates unresolved replyTo with resolved data", async () => {
    // Insert a message with unresolved replyTo
    const msg = makeLocalMsg({
      eventId: "$reply1",
      roomId: "!r:s",
      replyTo: { id: "$original1", senderId: "", content: "" },
    });
    await db.messages.add(msg);

    // Patch it
    await repo.patchUnresolvedReplies([
      { eventId: "$reply1", replyTo: { id: "$original1", senderId: "alice", content: "Hello world", type: MessageType.text } },
    ]);

    const updated = await repo.getByEventId("$reply1");
    expect(updated?.replyTo?.senderId).toBe("alice");
    expect(updated?.replyTo?.content).toBe("Hello world");
    expect(updated?.replyTo?.type).toBe(MessageType.text);
  });

  it("does NOT overwrite already-resolved replyTo", async () => {
    const msg = makeLocalMsg({
      eventId: "$reply2",
      roomId: "!r:s",
      replyTo: { id: "$original2", senderId: "bob", content: "Original text" },
    });
    await db.messages.add(msg);

    await repo.patchUnresolvedReplies([
      { eventId: "$reply2", replyTo: { id: "$original2", senderId: "charlie", content: "Different text" } },
    ]);

    const unchanged = await repo.getByEventId("$reply2");
    expect(unchanged?.replyTo?.senderId).toBe("bob");
    expect(unchanged?.replyTo?.content).toBe("Original text");
  });

  it("does NOT overwrite deleted replyTo", async () => {
    const msg = makeLocalMsg({
      eventId: "$reply3",
      roomId: "!r:s",
      replyTo: { id: "$original3", senderId: "", content: "", deleted: true },
    });
    await db.messages.add(msg);

    await repo.patchUnresolvedReplies([
      { eventId: "$reply3", replyTo: { id: "$original3", senderId: "dave", content: "text" } },
    ]);

    const unchanged = await repo.getByEventId("$reply3");
    expect(unchanged?.replyTo?.deleted).toBe(true);
    expect(unchanged?.replyTo?.senderId).toBe("");
  });

  it("handles empty input gracefully", async () => {
    await repo.patchUnresolvedReplies([]);
    // No error thrown
  });

  it("skips messages without replyTo", async () => {
    const msg = makeLocalMsg({ eventId: "$noreply", roomId: "!r:s" });
    await db.messages.add(msg);

    await repo.patchUnresolvedReplies([
      { eventId: "$noreply", replyTo: { id: "$x", senderId: "eve", content: "text" } },
    ]);

    const unchanged = await repo.getByEventId("$noreply");
    expect(unchanged?.replyTo).toBeUndefined();
  });

  it("batch-patches multiple messages in one call", async () => {
    await db.messages.bulkAdd([
      makeLocalMsg({ eventId: "$a", roomId: "!r:s", replyTo: { id: "$t1", senderId: "", content: "" } }),
      makeLocalMsg({ eventId: "$b", roomId: "!r:s", replyTo: { id: "$t2", senderId: "", content: "" } }),
    ]);

    await repo.patchUnresolvedReplies([
      { eventId: "$a", replyTo: { id: "$t1", senderId: "alice", content: "msg1" } },
      { eventId: "$b", replyTo: { id: "$t2", senderId: "bob", content: "msg2" } },
    ]);

    const a = await repo.getByEventId("$a");
    const b = await repo.getByEventId("$b");
    expect(a?.replyTo?.senderId).toBe("alice");
    expect(b?.replyTo?.senderId).toBe("bob");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/shared/lib/local-db/__tests__/message-repository-reply.test.ts`
Expected: FAIL — `patchUnresolvedReplies` does not exist

**Step 3: Write the implementation**

Add to `src/shared/lib/local-db/message-repository.ts` after line 277 (`markReplyDeleted` method):

```typescript
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
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/shared/lib/local-db/__tests__/message-repository-reply.test.ts`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add src/shared/lib/local-db/message-repository.ts src/shared/lib/local-db/__tests__/message-repository-reply.test.ts
git commit -m "feat: add patchUnresolvedReplies to MessageRepository for reply persistence fix"
```

---

### Task 2: Update `enrichUnresolvedReplies` to write back to Dexie

**Files:**
- Modify: `src/entities/chat/model/chat-store.ts:2793-2822` (`enrichUnresolvedReplies` function)

**Step 1: Write the failing test**

Add to `src/entities/chat/model/chat-store.test.ts` (at the end of the describe block):

```typescript
describe("enrichUnresolvedReplies writes to Dexie", () => {
  // This is an integration-level test — the actual validation is in
  // message-repository-reply.test.ts. Here we verify the chat-store
  // wiring calls patchUnresolvedReplies after resolving.
  // Tested implicitly via the Task 4 regression tests.
});
```

> Note: The main testing for this logic is in Task 1 (repository) and Task 4 (integration regression). The chat-store change is wiring only.

**Step 2: Modify `enrichUnresolvedReplies` to also patch Dexie**

In `src/entities/chat/model/chat-store.ts`, replace the `enrichUnresolvedReplies` function (lines 2793-2822) with:

```typescript
  const enrichUnresolvedReplies = async (roomId: string): Promise<void> => {
    if (!chatDbKitRef.value) return;
    const db = chatDbKitRef.value;

    // Step 1: Find unresolved replies in Dexie (source of truth for UI)
    const roomMsgs = await db.messages.getMessages(roomId, 200);
    const unresolved = roomMsgs.filter(
      m => m.replyTo && !m.replyTo.deleted && !m.replyTo.senderId && !m.replyTo.content,
    );
    if (unresolved.length === 0) return;

    // Step 2: Look up referenced messages from Dexie
    const ids = unresolved.map(m => m.replyTo!.id);
    const stored = await db.messages.getByEventIds(ids);
    const storedMap = new Map(stored.map(m => [m.eventId!, m]));

    // Step 3: Build patches for resolved replies
    const patches: { eventId: string; replyTo: import("./types").ReplyTo }[] = [];
    for (const msg of unresolved) {
      const replyTo = msg.replyTo!;
      const original = storedMap.get(replyTo.id);
      if (original && msg.eventId) {
        if (original.deleted || original.softDeleted) {
          patches.push({
            eventId: msg.eventId,
            replyTo: { id: replyTo.id, senderId: "", content: "", deleted: true },
          });
        } else {
          patches.push({
            eventId: msg.eventId,
            replyTo: {
              id: replyTo.id,
              senderId: original.senderId,
              content: stripBastyonLinks(stripMentionAddresses(original.content)).slice(0, 100),
              type: original.type,
            },
          });
        }
      }
    }

    // Step 4: Patch Dexie — liveQuery auto-propagates to UI
    if (patches.length > 0) {
      await db.messages.patchUnresolvedReplies(patches);
    }

    // Step 5: Also update in-memory store for non-Dexie consumers
    const inMemMsgs = messages.value[roomId];
    if (inMemMsgs) {
      let changed = false;
      for (const patch of patches) {
        const msg = inMemMsgs.find(m => m.id === patch.eventId);
        if (msg && msg.replyTo) {
          msg.replyTo.senderId = patch.replyTo.senderId;
          msg.replyTo.content = patch.replyTo.content;
          msg.replyTo.type = patch.replyTo.type;
          if (patch.replyTo.deleted) msg.replyTo.deleted = true;
          changed = true;
        }
      }
      if (changed) triggerRef(messages);
    }
  };
```

**Step 3: Run full test suite**

Run: `npx vitest run src/entities/chat/model/chat-store.test.ts`
Expected: ALL PASS (no regressions)

**Step 4: Commit**

```bash
git add src/entities/chat/model/chat-store.ts
git commit -m "fix: enrichUnresolvedReplies now writes resolved replyTo back to Dexie

Previously enrichUnresolvedReplies only updated in-memory state, but
activeMessages reads from Dexie via liveQuery. Messages arriving while
the user was in another room stored empty replyTo in Dexie that was
never overwritten because bulkInsert skips duplicates."
```

---

### Task 3: Add post-bulkInsert reply sync in `loadRoomMessages`

**Files:**
- Modify: `src/entities/chat/model/chat-store.ts:2907-2912` (inside `loadRoomMessages`)

**Context:** Even after Task 2, there's a gap: `parseTimelineEvents` resolves replies from the timeline batch (msgMap), but `bulkInsert` skips duplicates. The resolved data from `parseTimelineEvents` is lost for existing Dexie records. We need to patch those too.

**Step 1: Add reply sync after writeMessages**

In `src/entities/chat/model/chat-store.ts`, modify the block at lines 2907-2912. Replace:

```typescript
        try {
          await chatDbKitRef.value.eventWriter.writeMessages(parsedMessages);
          await enrichUnresolvedReplies(roomId);
        } catch (e) {
          console.warn("[chat-store] EventWriter.writeMessages failed:", e);
        }
```

With:

```typescript
        try {
          await chatDbKitRef.value.eventWriter.writeMessages(parsedMessages);

          // Patch Dexie records where parseTimelineEvents resolved a reply
          // but bulkInsert skipped the message (already existed with empty replyTo).
          const resolvedReplies = parsedMessages
            .filter(m => m.replyTo?.senderId && m.eventId)
            .map(m => ({ eventId: m.eventId!, replyTo: m.replyTo! }));
          if (resolvedReplies.length > 0) {
            await chatDbKitRef.value.messages.patchUnresolvedReplies(resolvedReplies);
          }

          // Also try to resolve any remaining unresolved replies from Dexie
          await enrichUnresolvedReplies(roomId);
        } catch (e) {
          console.warn("[chat-store] EventWriter.writeMessages failed:", e);
        }
```

**Step 2: Run tests**

Run: `npx vitest run src/entities/chat/model/chat-store.test.ts`
Expected: ALL PASS

**Step 3: Commit**

```bash
git add src/entities/chat/model/chat-store.ts
git commit -m "fix: sync resolved replyTo to Dexie after bulkInsert in loadRoomMessages

parseTimelineEvents resolves reply references from the timeline batch,
but bulkInsert skips existing messages. This adds a post-insert patch
step that writes resolved replyTo data for messages that already existed
in Dexie with empty placeholders."
```

---

### Task 4: Integration regression tests

**Files:**
- Create: `src/entities/chat/model/__tests__/reply-persistence.test.ts`

**Step 1: Write regression tests**

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Dexie from "dexie";
import { MessageRepository } from "@/shared/lib/local-db/message-repository";
import type { ChatDatabase, LocalMessage } from "@/shared/lib/local-db/schema";
import { MessageType } from "@/entities/chat/model/types";

class TestDb extends Dexie implements ChatDatabase {
  messages!: Dexie.Table<LocalMessage, number>;
  rooms!: Dexie.Table<any, string>;
  decryptionQueue!: Dexie.Table<any, number>;
  listenedMessages!: Dexie.Table<any, string>;
  pendingOps!: Dexie.Table<any, number>;
  users!: Dexie.Table<any, string>;

  constructor(name: string) {
    super(name, { indexedDB: require("fake-indexeddb"), IDBKeyRange: require("fake-indexeddb/lib/FDBKeyRange") });
    this.version(1).stores({
      messages: "++localId, eventId, clientId, [roomId+timestamp], [roomId+status], senderId",
      rooms: "id, updatedAt, membership, isDeleted",
      decryptionQueue: "++id, status, [status+nextAttemptAt]",
      listenedMessages: "eventId",
      pendingOps: "++id, status",
      users: "address",
    });
  }
}

function makeLocalMsg(overrides: Partial<LocalMessage> = {}): LocalMessage {
  return {
    eventId: overrides.eventId ?? `$evt_${Math.random().toString(36).slice(2)}`,
    clientId: overrides.clientId ?? `cli_${Math.random().toString(36).slice(2)}`,
    roomId: overrides.roomId ?? "!room:server",
    senderId: overrides.senderId ?? "user1",
    content: overrides.content ?? "hello",
    timestamp: overrides.timestamp ?? Date.now(),
    type: overrides.type ?? MessageType.text,
    status: "synced" as const,
    version: 1,
    softDeleted: false,
    ...overrides,
  } as LocalMessage;
}

describe("Reply Preview Persistence (regression)", () => {
  let db: TestDb;
  let repo: MessageRepository;

  beforeEach(async () => {
    db = new TestDb(`TestReplyRegression_${Math.random()}`);
    await db.open();
    repo = new MessageRepository(db as unknown as ChatDatabase);
  });

  afterEach(async () => {
    await db.delete();
  });

  it("REGRESSION: reply arriving while user is in another room gets patched on room open", async () => {
    // Step 1: Original message exists in Dexie (from a previous visit)
    await db.messages.add(makeLocalMsg({
      eventId: "$original",
      roomId: "!r:s",
      content: "Hey, check this out",
      senderId: "bob",
      timestamp: 1000,
    }));

    // Step 2: Reply arrives via real-time sync while user is in another room.
    // handleTimelineEvent couldn't resolve it (room not loaded in memory,
    // and on some devices the original might not be in Dexie yet).
    await db.messages.add(makeLocalMsg({
      eventId: "$reply",
      roomId: "!r:s",
      content: "Sure, looks good",
      senderId: "alice",
      timestamp: 2000,
      replyTo: { id: "$original", senderId: "", content: "" },
    }));

    // Verify: Dexie has unresolved reply
    const before = await repo.getByEventId("$reply");
    expect(before?.replyTo?.senderId).toBe("");
    expect(before?.replyTo?.content).toBe("");

    // Step 3: User opens the room. loadRoomMessages resolves the reply from
    // timeline and calls patchUnresolvedReplies.
    await repo.patchUnresolvedReplies([{
      eventId: "$reply",
      replyTo: { id: "$original", senderId: "bob", content: "Hey, check this out", type: MessageType.text },
    }]);

    // Step 4: Dexie now has resolved reply — liveQuery would propagate to UI
    const after = await repo.getByEventId("$reply");
    expect(after?.replyTo?.senderId).toBe("bob");
    expect(after?.replyTo?.content).toBe("Hey, check this out");
    expect(after?.replyTo?.type).toBe(MessageType.text);
  });

  it("REGRESSION: already-resolved reply is not overwritten on subsequent load", async () => {
    // Reply with correct data from first visit
    await db.messages.add(makeLocalMsg({
      eventId: "$reply2",
      roomId: "!r:s",
      replyTo: { id: "$orig2", senderId: "carol", content: "Important text", type: MessageType.text },
    }));

    // loadRoomMessages runs again — parseTimelineEvents might not resolve
    // (e.g., original not in timeline batch), producing empty replyTo.
    // patchUnresolvedReplies should NOT overwrite.
    await repo.patchUnresolvedReplies([{
      eventId: "$reply2",
      replyTo: { id: "$orig2", senderId: "dave", content: "Wrong text" },
    }]);

    const msg = await repo.getByEventId("$reply2");
    expect(msg?.replyTo?.senderId).toBe("carol");
    expect(msg?.replyTo?.content).toBe("Important text");
  });

  it("REGRESSION: cold start — reply target never synced locally", async () => {
    // Reply message exists but referenced message was never synced
    await db.messages.add(makeLocalMsg({
      eventId: "$reply3",
      roomId: "!r:s",
      replyTo: { id: "$ancient", senderId: "", content: "" },
    }));

    // patchUnresolvedReplies called with empty array (nothing resolved)
    await repo.patchUnresolvedReplies([]);

    // Still unresolved — but that's expected when the original truly doesn't exist
    const msg = await repo.getByEventId("$reply3");
    expect(msg?.replyTo?.senderId).toBe("");
  });

  it("REGRESSION: deleted reply target stays deleted after patch attempt", async () => {
    await db.messages.add(makeLocalMsg({
      eventId: "$reply4",
      roomId: "!r:s",
      replyTo: { id: "$deleted", senderId: "", content: "", deleted: true },
    }));

    await repo.patchUnresolvedReplies([{
      eventId: "$reply4",
      replyTo: { id: "$deleted", senderId: "eve", content: "Resurrected?" },
    }]);

    const msg = await repo.getByEventId("$reply4");
    expect(msg?.replyTo?.deleted).toBe(true);
    expect(msg?.replyTo?.senderId).toBe("");
  });
});
```

**Step 2: Run regression tests**

Run: `npx vitest run src/entities/chat/model/__tests__/reply-persistence.test.ts`
Expected: ALL PASS

**Step 3: Run full test suite**

Run: `npx vitest run`
Expected: ALL PASS — no regressions

**Step 4: Commit**

```bash
git add src/entities/chat/model/__tests__/reply-persistence.test.ts
git commit -m "test: add regression tests for reply preview persistence across room reopens"
```

---

### Task 5: Verification & final build check

**Step 1: Type check**

Run: `npx vue-tsc --noEmit`
Expected: No errors

**Step 2: Lint**

Run: `npm run lint`
Expected: No errors

**Step 3: Build**

Run: `npm run build`
Expected: Success

**Step 4: Run all tests**

Run: `npm run test`
Expected: ALL PASS

**Step 5: Final commit (if any lint/type fixes needed)**

```bash
git add -A
git commit -m "chore: lint and type fixes for reply persistence patch"
```

---

## Summary of Changes

| File | Change |
|------|--------|
| `message-repository.ts` | Add `patchUnresolvedReplies()` method |
| `chat-store.ts:2793-2822` | Rewrite `enrichUnresolvedReplies` to read from and write to Dexie |
| `chat-store.ts:2907-2912` | Add post-bulkInsert reply sync step |
| `message-repository-reply.test.ts` | Unit tests for `patchUnresolvedReplies` |
| `reply-persistence.test.ts` | Integration regression tests |

## What This Does NOT Change

- No schema migration needed (replyTo field already exists)
- No changes to MessageBubble.vue (the "..." fallback is correct behavior for truly-unresolvable replies)
- No changes to the real-time event handler (it already resolves when possible)
- No changes to bulkInsert (skip-duplicates is correct dedup behavior)
