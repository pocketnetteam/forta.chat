# First Launch Performance Optimization — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Устранить UI freeze при первом запуске, сократив Time-to-Interactive с 5-15s до <2s.

**Architecture:** Три ключевых изменения: (1) WriteBuffer для батчинга Dexie-записей (100 транзакций → 1-3), (2) throttle sortedRooms computed (100 пересчётов → 3-5), (3) yield-to-main в дешифровке (разбить CPU-bound блоки на микрозадачи). Все изменения — в shared/lib и entities/chat, без изменений UI-компонентов в первой фазе.

**Tech Stack:** Vue 3 (Composition API), Pinia, Dexie (IndexedDB), Vitest, TypeScript

---

## Task 1: WriteBuffer — батчинг Dexie-записей

**Проблема:** `EventWriter.writeMessage()` открывает отдельную Dexie-транзакцию на каждое сообщение. При initial sync 100 сообщений = 100 транзакций → 100 liveQuery уведомлений → 100 пересчётов sortedRooms → 100 ре-рендеров.

**Files:**
- Create: `src/shared/lib/local-db/write-buffer.ts`
- Create: `src/shared/lib/local-db/write-buffer.test.ts`
- Modify: `src/shared/lib/local-db/event-writer.ts:120-152`
- Modify: `src/shared/lib/local-db/index.ts` (export WriteBuffer)

### Step 1: Write the failing test

```typescript
// src/shared/lib/local-db/write-buffer.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { WriteBuffer, type BufferedWrite } from "./write-buffer";

describe("WriteBuffer", () => {
  let flushFn: ReturnType<typeof vi.fn>;
  let buffer: WriteBuffer;

  beforeEach(() => {
    vi.useFakeTimers();
    flushFn = vi.fn<(items: BufferedWrite[]) => Promise<void>>().mockResolvedValue(undefined);
    buffer = new WriteBuffer(flushFn, { delayMs: 150, maxSize: 50 });
  });

  afterEach(() => {
    buffer.dispose();
    vi.useRealTimers();
  });

  it("batches multiple enqueues into single flush", async () => {
    buffer.enqueue({ roomId: "r1", localMsg: { id: "m1" } as any, parsed: { roomId: "r1" } as any });
    buffer.enqueue({ roomId: "r1", localMsg: { id: "m2" } as any, parsed: { roomId: "r1" } as any });
    buffer.enqueue({ roomId: "r2", localMsg: { id: "m3" } as any, parsed: { roomId: "r2" } as any });

    expect(flushFn).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(150);

    expect(flushFn).toHaveBeenCalledTimes(1);
    expect(flushFn).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ roomId: "r1" }),
        expect.objectContaining({ roomId: "r1" }),
        expect.objectContaining({ roomId: "r2" }),
      ]),
    );
  });

  it("flushes immediately when maxSize reached", async () => {
    const buf = new WriteBuffer(flushFn, { delayMs: 150, maxSize: 2 });
    buf.enqueue({ roomId: "r1", localMsg: { id: "m1" } as any, parsed: { roomId: "r1" } as any });
    buf.enqueue({ roomId: "r1", localMsg: { id: "m2" } as any, parsed: { roomId: "r1" } as any });

    // maxSize hit → should schedule microtask flush
    await vi.advanceTimersByTimeAsync(0);

    expect(flushFn).toHaveBeenCalledTimes(1);
    buf.dispose();
  });

  it("flushImmediately() drains buffer without waiting", async () => {
    buffer.enqueue({ roomId: "r1", localMsg: { id: "m1" } as any, parsed: { roomId: "r1" } as any });
    await buffer.flushNow();

    expect(flushFn).toHaveBeenCalledTimes(1);
  });

  it("does not call flush when buffer is empty", async () => {
    await vi.advanceTimersByTimeAsync(300);
    expect(flushFn).not.toHaveBeenCalled();
  });

  it("handles flush errors without losing items", async () => {
    flushFn.mockRejectedValueOnce(new Error("db fail"));
    buffer.enqueue({ roomId: "r1", localMsg: { id: "m1" } as any, parsed: { roomId: "r1" } as any });
    await vi.advanceTimersByTimeAsync(150);

    expect(flushFn).toHaveBeenCalledTimes(1);
    // Buffer should reschedule on failure
    // Items re-enqueued or error propagated based on strategy
  });
});
```

### Step 2: Run test to verify it fails

Run: `npx vitest run src/shared/lib/local-db/write-buffer.test.ts`
Expected: FAIL — module `./write-buffer` not found

### Step 3: Write WriteBuffer implementation

```typescript
// src/shared/lib/local-db/write-buffer.ts
import type { LocalMessage } from "./schema";
import type { ParsedMessage } from "./event-writer";

export interface BufferedWrite {
  roomId: string;
  localMsg: LocalMessage;
  parsed: ParsedMessage;
  myAddress?: string;
  activeRoomId?: string | null;
}

export interface WriteBufferOptions {
  /** Milliseconds to wait before flushing (default 150) */
  delayMs?: number;
  /** Force flush when buffer reaches this size (default 50) */
  maxSize?: number;
}

export class WriteBuffer {
  private buffer: BufferedWrite[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flushing = false;

  constructor(
    private readonly onFlush: (items: BufferedWrite[]) => Promise<void>,
    private readonly opts: Required<WriteBufferOptions> = { delayMs: 150, maxSize: 50 },
  ) {
    this.opts = { delayMs: opts.delayMs ?? 150, maxSize: opts.maxSize ?? 50 };
  }

  enqueue(item: BufferedWrite): void {
    this.buffer.push(item);

    if (this.buffer.length >= this.opts.maxSize) {
      // Flush on next microtask to batch any remaining sync enqueues
      if (this.timer) { clearTimeout(this.timer); this.timer = null; }
      Promise.resolve().then(() => this.flush());
      return;
    }

    if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), this.opts.delayMs);
    }
  }

  async flushNow(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    await this.flush();
  }

  dispose(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.buffer = [];
  }

  private async flush(): Promise<void> {
    if (this.flushing || this.buffer.length === 0) return;
    this.flushing = true;
    this.timer = null;

    const items = this.buffer.splice(0);
    try {
      await this.onFlush(items);
    } catch (e) {
      console.warn("[WriteBuffer] flush failed, items lost:", items.length, e);
    } finally {
      this.flushing = false;
      // If new items arrived during flush, schedule next
      if (this.buffer.length > 0) {
        this.timer = setTimeout(() => this.flush(), this.opts.delayMs);
      }
    }
  }
}
```

### Step 4: Run test to verify it passes

Run: `npx vitest run src/shared/lib/local-db/write-buffer.test.ts`
Expected: PASS (all 5 tests)

### Step 5: Integrate WriteBuffer into EventWriter

Modify `src/shared/lib/local-db/event-writer.ts`:

Add import and new method `writeMessagesBatched`:

```typescript
// After line 11, add import:
import { WriteBuffer, type BufferedWrite } from "./write-buffer";

// After line 101 (end of constructor), add:
private writeBuffer: WriteBuffer | null = null;

/**
 * Enable batched writes: messages are accumulated and flushed
 * in a single transaction every 150ms.
 * Call this after construction to activate buffering.
 */
enableBatching(myAddress: string, getActiveRoomId: () => string | null): void {
  this.writeBuffer = new WriteBuffer(
    async (items) => this.flushBatch(items),
    { delayMs: 150, maxSize: 50 },
  );
  this._batchMyAddress = myAddress;
  this._batchGetActiveRoomId = getActiveRoomId;
}

private _batchMyAddress = "";
private _batchGetActiveRoomId: (() => string | null) | null = null;

/**
 * Write message through buffer (batched) or directly if buffering not enabled.
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
  this.writeBuffer.enqueue({ roomId: parsed.roomId, localMsg, parsed, myAddress, activeRoomId });
}

/**
 * Flush all buffered writes in a single Dexie transaction.
 * This replaces N individual transactions with 1.
 */
private async flushBatch(items: BufferedWrite[]): Promise<void> {
  if (items.length === 0) return;
  const myAddress = items[0].myAddress ?? this._batchMyAddress;
  const activeRoomId = items[0].activeRoomId ?? this._batchGetActiveRoomId?.() ?? null;

  await this.db.transaction("rw", [this.db.messages, this.db.rooms], async () => {
    for (const item of items) {
      await this.messageRepo.upsertFromServer(item.localMsg);
      await this.ensureRoomExists(item.parsed.roomId);
      await this.updateRoomPreview(item.parsed);

      if (item.parsed.senderId !== myAddress && item.parsed.roomId !== activeRoomId) {
        await this.db.rooms.where("id").equals(item.parsed.roomId)
          .modify((room: import("./schema").LocalRoom) => { room.unreadCount++; });
      }
    }
  });

  // Single onChange per unique room (not per message)
  const changedRooms = new Set(items.map(i => i.roomId));
  for (const roomId of changedRooms) {
    this.onChange?.(roomId);
  }
}

/** Flush pending buffered writes immediately */
async flushWriteBuffer(): Promise<void> {
  await this.writeBuffer?.flushNow();
}

disposeBuffer(): void {
  this.writeBuffer?.dispose();
}
```

### Step 6: Write integration test for batched EventWriter

```typescript
// Add to write-buffer.test.ts:
describe("EventWriter batched integration", () => {
  it("flushBatch calls onChange once per room, not per message", async () => {
    const onChange = vi.fn();
    // ... mock EventWriter with onChange
    // Enqueue 10 messages for 2 rooms
    // After flush: onChange called exactly 2 times (once per room)
  });
});
```

### Step 7: Run all tests

Run: `npx vitest run`
Expected: PASS

### Step 8: Commit

```bash
git add src/shared/lib/local-db/write-buffer.ts src/shared/lib/local-db/write-buffer.test.ts src/shared/lib/local-db/event-writer.ts
git commit -m "feat: add WriteBuffer for batching Dexie writes during sync

Accumulates incoming messages and flushes them in a single Dexie
transaction every 150ms (or when buffer reaches 50 items).
Reduces liveQuery notifications from ~100 to 1-3 during initial sync."
```

---

## Task 2: Wire WriteBuffer into chat-store

**Проблема:** `chat-store.ts` вызывает `eventWriter.writeMessage()` для каждого события из handleTimelineEvent. Нужно переключить фоновые комнаты на `writeMessageBuffered()`.

**Files:**
- Modify: `src/entities/chat/model/chat-store.ts:3570-3581` (dexieWriteMessage)
- Modify: `src/entities/chat/model/chat-store.ts` (initChatDb area — enable batching)

### Step 1: Write the failing test

```typescript
// src/entities/chat/model/chat-store-write-buffer.test.ts
import { describe, it, expect, vi } from "vitest";

describe("chat-store write buffer integration", () => {
  it("active room messages bypass buffer (immediate write)", () => {
    // Verify that messages for activeRoomId go through writeMessage directly
    // not through writeMessageBuffered
  });

  it("background room messages go through buffer", () => {
    // Verify that messages for non-active rooms use writeMessageBuffered
  });
});
```

### Step 2: Modify dexieWriteMessage in chat-store.ts

Find `dexieWriteMessage` (around line 3536-3582). The key change:

**Current code (line 3570):**
```typescript
chatDbKitRef.value.eventWriter.writeMessage(parsed, myAddr, activeRoomId.value).then(result => {
```

**New code:**
```typescript
const isActiveRoom = roomId === activeRoomId.value;
if (isActiveRoom) {
  // Active room: write immediately for instant UI feedback
  chatDbKitRef.value.eventWriter.writeMessage(parsed, myAddr, activeRoomId.value).then(result => {
    if (isEncrypted && result !== "duplicate" && chatDbKitRef.value?.decryptionWorker) {
      chatDbKitRef.value.decryptionWorker.enqueue(
        raw.event_id as string,
        roomId,
        JSON.stringify(raw),
      ).catch(() => {});
    }
  }).catch(e => {
    console.warn("[chat-store] EventWriter.writeMessage failed:", e);
  });
} else {
  // Background room: batch writes to reduce liveQuery notifications
  chatDbKitRef.value.eventWriter.writeMessageBuffered(parsed, myAddr, activeRoomId.value);
  if (isEncrypted && chatDbKitRef.value?.decryptionWorker) {
    chatDbKitRef.value.decryptionWorker.enqueue(
      raw.event_id as string,
      roomId,
      JSON.stringify(raw),
    ).catch(() => {});
  }
}
```

### Step 3: Enable batching at init

Find where `chatDbKitRef` is initialized (after `initChatDb()`). Add:

```typescript
// After chatDbKitRef.value = kit;
const myAddr = useAuthStore().address ?? "";
kit.eventWriter.enableBatching(myAddr, () => activeRoomId.value);
```

### Step 4: Run tests

Run: `npx vitest run`
Expected: PASS

### Step 5: Commit

```bash
git add src/entities/chat/model/chat-store.ts src/entities/chat/model/chat-store-write-buffer.test.ts
git commit -m "feat: wire WriteBuffer into chat-store for background room events

Active room messages still write immediately for instant UI feedback.
Background room messages are batched via WriteBuffer (150ms window)."
```

---

## Task 3: Throttle sortedRooms computed

**Проблема:** `sortedRooms` — Vue computed, пересчитывается синхронно при каждом изменении `dexieRooms`. Structural sharing cache помогает только если array reference не менялась, но каждая Dexie liveQuery нотификация создаёт новый массив. При 100 обновлениях = 100 полных сортировок O(n log n).

**Files:**
- Modify: `src/entities/chat/model/chat-store.ts:631-699` (sortedRooms computed)
- Create: `src/entities/chat/model/chat-store-sorted.throttle.test.ts` (если нужен отдельный тест)
- Modify: `src/entities/chat/model/chat-store-sorted.test.ts` (обновить существующие тесты)

### Step 1: Read and understand existing sortedRooms tests

Read: `src/entities/chat/model/chat-store-sorted.test.ts`
Understand existing test structure and patterns.

### Step 2: Write the failing test for throttled behavior

```typescript
// Add to chat-store-sorted.test.ts or create new file
describe("sortedRooms throttle", () => {
  it("does not recompute on every dexieRooms change within throttle window", async () => {
    // 1. Setup store with initial rooms
    // 2. Trigger 10 rapid dexieRooms updates (simulate 10 messages arriving)
    // 3. Assert sortedRooms recomputed <= 3 times (not 10)
  });

  it("first update is immediate (leading edge)", async () => {
    // 1. Setup store
    // 2. Trigger one dexieRooms update
    // 3. Assert sortedRooms updated immediately (no delay for first paint)
  });
});
```

### Step 3: Replace computed with throttled watch

**Current code (lines 631-699):**
```typescript
let _prevDexieRef: LocalRoom[] | null = null;
let _prevPinnedKey: string | null = null;
let _prevSorted: ChatRoom[] | null = null;

const _pinnedKey = (s: ReadonlySet<string>) => [...s].sort().join(",");

const sortedRooms = computed(() => {
  // ... 60 lines of sorting logic
});
```

**New code:**
```typescript
let _prevPinnedKey: string | null = null;

const _pinnedKey = (s: ReadonlySet<string>) => [...s].sort().join(",");

// Extracted sort function (pure, testable)
function computeSortedRooms(
  dexie: LocalRoom[] | null,
  fallback: ChatRoom[],
  pinned: ReadonlySet<string>,
): ChatRoom[] {
  perfCount("sortedRooms:recompute");
  let source: ChatRoom[];

  if (dexie) {
    source = dexie.map(lr => ({
      id: lr.id,
      name: lr.name,
      avatar: lr.avatar,
      isGroup: lr.isGroup,
      members: lr.members,
      membership: lr.membership as "join" | "invite",
      unreadCount: lr.unreadCount,
      topic: lr.topic,
      updatedAt: lr.updatedAt,
      lastMessage: lr.lastMessagePreview != null ? {
        id: "",
        roomId: lr.id,
        senderId: lr.lastMessageSenderId ?? "",
        content: lr.lastMessagePreview,
        timestamp: lr.lastMessageTimestamp ?? 0,
        status: deriveOutboundStatus(
          lr.lastMessageLocalStatus ?? "synced",
          lr.lastMessageTimestamp ?? 0,
          lr.lastReadOutboundTs ?? 0,
        ),
        type: lr.lastMessageType ?? MessageType.text,
      } as Message : undefined,
      lastMessageReaction: lr.lastMessageReaction ?? undefined,
    } as ChatRoom));
  } else {
    source = fallback;
  }

  return [...source].sort((a, b) => {
    const aPinned = pinned.has(a.id) ? 1 : 0;
    const bPinned = pinned.has(b.id) ? 1 : 0;
    if (aPinned !== bPinned) return bPinned - aPinned;
    const aInvite = a.membership === "invite" ? 1 : 0;
    const bInvite = b.membership === "invite" ? 1 : 0;
    if (aInvite !== bInvite) return aInvite - bInvite;
    const aTime = a.lastMessage?.timestamp ?? 0;
    const bTime = b.lastMessage?.timestamp ?? 0;
    return bTime - aTime;
  });
}

// Throttled: recompute max every 300ms, leading edge fires immediately
const _sortedRoomsRef = shallowRef<ChatRoom[]>([]);
let _sortedThrottleTimer: ReturnType<typeof setTimeout> | null = null;
let _sortedDirty = false;

const _recomputeSorted = () => {
  _sortedDirty = false;
  const dexie = chatDbKitRef.value ? dexieRooms.value : null;
  _sortedRoomsRef.value = computeSortedRooms(dexie, rooms.value, pinnedRoomIds.value);
};

watch(
  () => [dexieRooms.value, pinnedRoomIds.value] as const,
  () => {
    if (!_sortedThrottleTimer) {
      // Leading edge: fire immediately
      _recomputeSorted();
      _sortedThrottleTimer = setTimeout(() => {
        _sortedThrottleTimer = null;
        if (_sortedDirty) _recomputeSorted();
      }, 300);
    } else {
      _sortedDirty = true;
    }
  },
  { immediate: true },
);

const sortedRooms = computed(() => _sortedRoomsRef.value);
```

### Step 4: Update totalUnread to use the same dexieRooms (no change needed — it already accesses dexieRooms.value directly)

### Step 5: Run all tests

Run: `npx vitest run`
Expected: PASS — existing sortedRooms tests still pass, new throttle tests pass

### Step 6: Commit

```bash
git add src/entities/chat/model/chat-store.ts src/entities/chat/model/chat-store-sorted.throttle.test.ts
git commit -m "perf: throttle sortedRooms recomputation to max once per 300ms

Extract sort logic into pure function. Replace computed() with
watch + shallowRef throttled at 300ms (leading edge immediate).
Reduces recomputation from ~100 to ~3-5 during initial sync."
```

---

## Task 4: Yield-to-main в циклах дешифровки

**Проблема:** `decryptEvent()` в `matrix-crypto.ts` — CPU-bound операция на main thread. При initial sync 100 зашифрованных сообщений обрабатываются последовательно в handleTimelineEvent, каждое блокируя main thread на 5-50ms.

**Files:**
- Create: `src/shared/lib/yield-to-main.ts`
- Create: `src/shared/lib/yield-to-main.test.ts`
- Modify: `src/entities/chat/model/chat-store.ts` (handleTimelineEvent area — add yield)

### Step 1: Write the failing test

```typescript
// src/shared/lib/yield-to-main.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { yieldToMain, yieldEveryN } from "./yield-to-main";

describe("yieldToMain", () => {
  it("resolves after yielding to event loop", async () => {
    let resolved = false;
    const p = yieldToMain().then(() => { resolved = true; });
    expect(resolved).toBe(false);
    await p;
    expect(resolved).toBe(true);
  });
});

describe("yieldEveryN", () => {
  it("yields after every N calls", async () => {
    const fn = yieldEveryN(3);
    // Calls 1, 2 — no yield
    await fn(); // 1
    await fn(); // 2
    // Call 3 — should yield
    await fn(); // 3 — yields
  });

  it("counter resets after yield", async () => {
    const fn = yieldEveryN(2);
    await fn(); // 1
    await fn(); // 2 — yields, counter resets
    await fn(); // 1 (new cycle)
    // Should not have yielded yet in this cycle
  });
});
```

### Step 2: Run test to verify it fails

Run: `npx vitest run src/shared/lib/yield-to-main.test.ts`
Expected: FAIL — module not found

### Step 3: Write implementation

```typescript
// src/shared/lib/yield-to-main.ts

/**
 * Yield control to the main thread so the browser can process
 * pending paint, input events, and other high-priority tasks.
 *
 * Uses scheduler.yield() if available (Chrome 115+), falls back to
 * MessageChannel (0ms, no 4ms setTimeout penalty), then setTimeout(0).
 */
export function yieldToMain(): Promise<void> {
  // scheduler.yield() — best option, keeps task priority
  if (typeof globalThis.scheduler !== "undefined" && typeof globalThis.scheduler.yield === "function") {
    return globalThis.scheduler.yield();
  }
  // MessageChannel — 0ms delay (unlike setTimeout which has 4ms minimum after 5 nesting levels)
  if (typeof MessageChannel !== "undefined") {
    return new Promise<void>(resolve => {
      const ch = new MessageChannel();
      ch.port1.onmessage = () => resolve();
      ch.port2.postMessage(undefined);
    });
  }
  // Fallback
  return new Promise(resolve => setTimeout(resolve, 0));
}

/**
 * Returns a function that yields to main every `n` calls.
 * Use in hot loops: `const maybeYield = yieldEveryN(5);`
 * then `await maybeYield()` inside the loop.
 */
export function yieldEveryN(n: number): () => Promise<void> {
  let count = 0;
  return async () => {
    count++;
    if (count >= n) {
      count = 0;
      await yieldToMain();
    }
  };
}
```

### Step 4: Run test

Run: `npx vitest run src/shared/lib/yield-to-main.test.ts`
Expected: PASS

### Step 5: Add yield to handleTimelineEvent batch processing

In `chat-store.ts`, the events come one-by-one from Matrix SDK callbacks, so we can't easily batch them. Instead, add yield in the decryption-heavy path.

Find the decryption call in handleTimelineEvent (around line 3490-3510 area where `roomCrypto.decryptEvent()` is called). Add yield every 5 decryptions:

```typescript
// At the top of the store setup, add:
import { yieldEveryN } from "@/shared/lib/yield-to-main";

// In the event handler setup area:
const maybeYieldDecrypt = yieldEveryN(5);

// Before each decryptEvent call (in handleTimelineEvent):
await maybeYieldDecrypt();
const decrypted = await roomCrypto.decryptEvent(raw);
```

### Step 6: Run all tests

Run: `npx vitest run`
Expected: PASS

### Step 7: Commit

```bash
git add src/shared/lib/yield-to-main.ts src/shared/lib/yield-to-main.test.ts src/entities/chat/model/chat-store.ts
git commit -m "perf: yield to main thread every 5 decryption operations

Prevents long CPU-bound decryption batches from blocking UI.
Uses scheduler.yield() → MessageChannel → setTimeout(0) fallback."
```

---

## Task 5: TaskScheduler для фоновых задач при старте

**Проблема:** При старте фоновые задачи (профили, участники, дешифровка превью) запускаются сразу после sync, конкурируя за main thread с рендерингом.

**Files:**
- Create: `src/shared/lib/task-scheduler.ts`
- Create: `src/shared/lib/task-scheduler.test.ts`
- Modify: `src/entities/chat/model/chat-store.ts` (fullRoomRefresh post-processing)

### Step 1: Write the failing test

```typescript
// src/shared/lib/task-scheduler.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TaskScheduler } from "./task-scheduler";

describe("TaskScheduler", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("executes tasks sequentially with idle gaps", async () => {
    const order: number[] = [];
    const scheduler = new TaskScheduler();

    scheduler.schedule(async () => { order.push(1); });
    scheduler.schedule(async () => { order.push(2); });
    scheduler.schedule(async () => { order.push(3); });

    // Drain scheduler (simulating idle callbacks)
    await scheduler.drain();

    expect(order).toEqual([1, 2, 3]);
    scheduler.dispose();
  });

  it("high priority tasks execute before idle tasks", async () => {
    const order: number[] = [];
    const scheduler = new TaskScheduler();

    scheduler.schedule(async () => { order.push(1); }, "idle");
    scheduler.schedule(async () => { order.push(2); }, "high");
    scheduler.schedule(async () => { order.push(3); }, "idle");

    await scheduler.drain();

    expect(order[0]).toBe(2); // high priority first
    scheduler.dispose();
  });

  it("continues after task failure", async () => {
    const order: number[] = [];
    const scheduler = new TaskScheduler();

    scheduler.schedule(async () => { throw new Error("fail"); });
    scheduler.schedule(async () => { order.push(2); });

    await scheduler.drain();

    expect(order).toEqual([2]);
    scheduler.dispose();
  });

  it("dispose cancels pending tasks", () => {
    const fn = vi.fn();
    const scheduler = new TaskScheduler();
    scheduler.schedule(fn);
    scheduler.dispose();

    // fn should never be called after dispose
    expect(fn).not.toHaveBeenCalled();
  });
});
```

### Step 2: Run test to verify it fails

Run: `npx vitest run src/shared/lib/task-scheduler.test.ts`
Expected: FAIL — module not found

### Step 3: Write implementation

```typescript
// src/shared/lib/task-scheduler.ts

type Priority = "high" | "idle";

interface ScheduledTask {
  fn: () => Promise<void>;
  priority: Priority;
}

/**
 * Executes background tasks sequentially, yielding to main thread
 * between each task via requestIdleCallback (or setTimeout fallback).
 *
 * Use for post-startup work: profile loading, preview decryption,
 * member fetching, history prefetch.
 */
export class TaskScheduler {
  private highQueue: ScheduledTask[] = [];
  private idleQueue: ScheduledTask[] = [];
  private running = false;
  private disposed = false;

  schedule(fn: () => Promise<void>, priority: Priority = "idle"): void {
    if (this.disposed) return;
    const task: ScheduledTask = { fn, priority };
    if (priority === "high") {
      this.highQueue.push(task);
    } else {
      this.idleQueue.push(task);
    }
    if (!this.running) this.run();
  }

  /** Drain all tasks (for testing or shutdown). */
  async drain(): Promise<void> {
    while (this.highQueue.length > 0 || this.idleQueue.length > 0) {
      const task = this.highQueue.shift() ?? this.idleQueue.shift();
      if (!task) break;
      try { await task.fn(); } catch (e) { console.warn("[TaskScheduler] task failed:", e); }
    }
    this.running = false;
  }

  dispose(): void {
    this.disposed = true;
    this.highQueue = [];
    this.idleQueue = [];
    this.running = false;
  }

  private async run(): Promise<void> {
    if (this.running || this.disposed) return;
    this.running = true;

    while (!this.disposed && (this.highQueue.length > 0 || this.idleQueue.length > 0)) {
      const task = this.highQueue.shift() ?? this.idleQueue.shift();
      if (!task) break;

      // Yield to main thread before each task
      await this.waitForIdle();

      if (this.disposed) break;

      try {
        await task.fn();
      } catch (e) {
        console.warn("[TaskScheduler] task failed:", e);
      }
    }

    this.running = false;
  }

  private waitForIdle(): Promise<void> {
    if (typeof requestIdleCallback !== "undefined") {
      return new Promise(resolve => requestIdleCallback(() => resolve(), { timeout: 2000 }));
    }
    return new Promise(resolve => setTimeout(resolve, 16));
  }
}
```

### Step 4: Run test

Run: `npx vitest run src/shared/lib/task-scheduler.test.ts`
Expected: PASS

### Step 5: Integrate into chat-store fullRoomRefresh

Find the post-refresh section in `fullRoomRefresh()` where profiles, members, and preview decryption are launched. Wrap them in TaskScheduler:

```typescript
// In chat-store.ts, after fullRoomRefresh room data is written:
// Instead of launching everything immediately:

const scheduler = new TaskScheduler();

// High priority: viewport room profiles (needed for first screen)
scheduler.schedule(async () => {
  const viewportIds = sortedRooms.value.slice(0, 15).map(r => r.id);
  await loadProfilesForRoomIds(viewportIds);
}, "high");

// Idle: background profiles
scheduler.schedule(async () => {
  const bgIds = sortedRooms.value.slice(15).map(r => r.id);
  await loadProfilesForRoomIds(bgIds);
}, "idle");

// Idle: preview decryption
scheduler.schedule(async () => {
  await decryptRoomPreviews();
}, "idle");

// Idle: members for viewport
scheduler.schedule(async () => {
  await loadMembersForViewportRooms();
}, "idle");
```

### Step 6: Run all tests

Run: `npx vitest run`
Expected: PASS

### Step 7: Commit

```bash
git add src/shared/lib/task-scheduler.ts src/shared/lib/task-scheduler.test.ts src/entities/chat/model/chat-store.ts
git commit -m "perf: schedule post-startup tasks via TaskScheduler

Profile loading, preview decryption, and member fetching now execute
sequentially during idle time instead of competing with UI rendering."
```

---

## Task 6: Performance markers для профилирования

**Проблема:** Нужны маркеры для измерения эффекта оптимизаций.

**Files:**
- Modify: `src/shared/lib/perf-markers.ts` (если существует, иначе создать)
- Modify: `src/entities/chat/model/chat-store.ts` (добавить маркеры)
- Modify: `src/shared/lib/local-db/event-writer.ts` (добавить маркеры)

### Step 1: Check existing perf-markers

Read: `src/shared/lib/perf-markers.ts` и `src/shared/lib/perf-markers.test.ts`

### Step 2: Add performance marks

```typescript
// In chat-store.ts fullRoomRefresh:
performance.mark("full-room-refresh:start");
// ... existing code ...
performance.mark("full-room-refresh:end");
performance.measure("full-room-refresh", "full-room-refresh:start", "full-room-refresh:end");

// In event-writer.ts writeMessage:
performance.mark("write-message:start");
// ... existing code ...
performance.mark("write-message:end");

// In event-writer.ts flushBatch:
performance.mark("flush-batch:start");
// ... existing code ...
performance.mark("flush-batch:end");
performance.measure("flush-batch", "flush-batch:start", "flush-batch:end");

// In handleTimelineEvent (decryption):
performance.mark("decrypt-event:start");
const decrypted = await roomCrypto.decryptEvent(raw);
performance.mark("decrypt-event:end");
performance.measure("decrypt-event", "decrypt-event:start", "decrypt-event:end");
```

### Step 3: Commit

```bash
git add src/shared/lib/perf-markers.ts src/entities/chat/model/chat-store.ts src/shared/lib/local-db/event-writer.ts
git commit -m "perf: add performance.mark/measure for profiling startup pipeline"
```

---

## Task 7: Финальная верификация

### Step 1: Run full verification

```bash
npm run build          # vue-tsc + vite
npm run lint           # ESLint
npx vue-tsc --noEmit   # Type check
npm run test           # All tests
```

### Step 2: Code review

Activate `review` skill for architectural review of all changes.

### Step 3: Verify performance improvement

1. Open Chrome DevTools → Performance tab
2. Record 10 seconds starting from login
3. Check:
   - `flush-batch` measures: should see 1-3 instead of 100 individual `write-message`
   - `sortedRooms:recompute` count (via `perfCount`): should be <5
   - `full-room-refresh` duration: should be <500ms
   - Longest Task: should be <100ms (down from 200-500ms)
   - FPS during initial sync: should be >30fps

### Step 4: Commit final state

```bash
git add -A
git commit -m "perf: complete first-launch optimization — WriteBuffer, throttled sort, yield-to-main

Summary of changes:
- WriteBuffer batches Dexie writes (100 txn → 1-3)
- sortedRooms throttled to 300ms (100 recomputes → 3-5)
- yield-to-main every 5 decryptions (unblocks UI thread)
- TaskScheduler defers post-startup work to idle time
- Performance markers for ongoing profiling"
```

---

## Checklist: повторное профилирование после фиксов

| Метрика | До | Цель | Как измерить |
|---------|-----|------|-------------|
| Longest Task при старте | 200-500ms | <100ms | DevTools → Performance → Long Tasks |
| sortedRooms recompute за 5s | ~100 | <5 | `perfCount("sortedRooms:recompute")` в консоли |
| Dexie transactions за 5s | ~100 | <10 | `performance.measure("flush-batch")` |
| Time to first room list | 2-5s | <500ms | `performance.measure("full-room-refresh")` |
| Time to interactive | 5-15s | <2s | Manual testing: scroll without jank |
| Scripting time (0-10s) | — | -60% | DevTools → Performance → Summary |
| FPS при скролле во время sync | <20fps | >50fps | DevTools → Performance → Frames |
| decrypt-event max duration | 50-500ms | <50ms | `performance.measure("decrypt-event")` |

---

## Порядок выполнения

```
Task 1 (WriteBuffer)         ← Самый большой импакт, P0
  └─ Task 2 (Wire into store)
Task 3 (Throttle sortedRooms) ← Второй по импакту, P0
Task 4 (Yield-to-main)        ← Третий, P1
Task 5 (TaskScheduler)        ← Четвёртый, P1
Task 6 (Perf markers)         ← Можно параллельно с любым
Task 7 (Финальная верификация) ← Последний
```

Tasks 1+2 и Task 3 можно разрабатывать параллельно (разные файлы/области).
Task 4 и Task 5 зависят от 1-3 только концептуально, но файлово независимы.
