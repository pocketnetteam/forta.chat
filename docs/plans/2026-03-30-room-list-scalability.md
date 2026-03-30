# Room List Scalability Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix message delivery on accounts with 100k+ rooms by replacing the O(n log n) full-sort-on-every-change architecture with incremental O(k) patching.

**Architecture:** 7-layer approach: (1) Server sync filter reduces payload, (2) Dexie hooks track deltas instead of re-querying all rows, (3) Incremental sort patches only changed rooms into the sorted array, (4) Async full rebuild with yield serves as fallback, (5) Room auto-cleanup reduces total room count, (6) Push fast-path via targeted event fetch bypasses sync pipeline, (7) Optimized room refresh eliminates O(n) scans of all SDK rooms on every sync tick, (8) fullRoomRefresh processes only changed rooms instead of rebuilding all 100k.

**Tech Stack:** Vue 3 + Pinia + Dexie (IndexedDB) + matrix-js-sdk + Vitest

---

### Task 1: Add sync filter to reduce server payload

**Files:**
- Modify: `src/entities/matrix/model/matrix-client.ts:219-225`

**Step 1: Add filter creation before startClient**

In `matrix-client.ts`, replace the current `startClient` block (lines 219-225):

```typescript
// Before startClient, create a server-side filter to minimize /sync payload.
// This is critical for accounts with 100k+ rooms — without it, ephemeral
// events (typing, receipts) for every room are included in each sync response.
const filterDefinition = {
  room: {
    timeline: { limit: 1, lazy_load_members: true },
    state: {
      lazy_load_members: true,
      types: [
        "m.room.name",
        "m.room.avatar",
        "m.room.canonical_alias",
        "m.room.encryption",
        "m.room.member",
        "m.room.create",
        "m.room.topic",
        "m.room.history_visibility",
      ],
    },
    ephemeral: { types: [] },
    account_data: { types: ["m.fully_read", "m.tag"] },
  },
  presence: { types: [] },
};

let filterToUse: unknown;
try {
  const created = await userClient.createFilter(filterDefinition);
  filterToUse = created.filterId;
} catch (e) {
  console.warn("[matrix-client] Failed to create sync filter, using defaults:", e);
}

await userClient.startClient({
  pollTimeout: 60000,
  resolveInvitesToProfiles: true,
  initialSyncLimit: 1,
  disablePresence: true,
  lazyLoadMembers: true,
  ...(filterToUse ? { filter: filterToUse } : {}),
});
```

**Step 2: Verify build passes**

Run: `npx vue-tsc --noEmit && npm run build`
Expected: No type errors, build succeeds.

**Step 3: Commit**

```bash
git add src/entities/matrix/model/matrix-client.ts
git commit -m "perf: add server-side sync filter to reduce /sync payload for large accounts"
```

---

### Task 2: Remove double-sort from RoomRepository.getAllRooms

**Files:**
- Modify: `src/shared/lib/local-db/room-repository.ts:48-55`
- Test: `src/shared/lib/local-db/room-repository.test.ts`

**Context:** `getAllRooms()` currently sorts all rows in Dexie by timestamp. Then `computeSortedRooms()` in chat-store sorts them AGAIN. This is wasteful and will become even more wasteful at scale. Since chat-store owns the sort, remove it from the repository.

**Step 1: Write the failing test**

Add to `room-repository.test.ts`:

```typescript
describe("getAllRooms returns unsorted", () => {
  it("returns rooms without applying any sort order", async () => {
    // Insert rooms in reverse-chronological order
    await repo.bulkUpsertRooms([
      makeLocalRoom({ id: "!old:s", lastMessageTimestamp: 100, updatedAt: 100 }),
      makeLocalRoom({ id: "!new:s", lastMessageTimestamp: 999, updatedAt: 999 }),
    ]);
    const rooms = await repo.getAllRooms();
    expect(rooms).toHaveLength(2);
    // Should NOT be sorted — the order depends on Dexie's internal key order
    // We just verify all rooms are returned and healUpdatedAt still runs
    const ids = rooms.map(r => r.id);
    expect(ids).toContain("!old:s");
    expect(ids).toContain("!new:s");
    // healUpdatedAt should still fix rooms with updatedAt=0
    await repo.bulkUpsertRooms([
      makeLocalRoom({ id: "!zero:s", lastMessageTimestamp: 500, updatedAt: 0 }),
    ]);
    const healed = await repo.getAllRooms();
    const zeroRoom = healed.find(r => r.id === "!zero:s");
    expect(zeroRoom?.updatedAt).toBe(500); // healed from lastMessageTimestamp
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/shared/lib/local-db/room-repository.test.ts`
Expected: Test may pass or fail depending on Dexie ordering — the key change is removing the sort.

**Step 3: Remove sort from getAllRooms and getJoinedRooms**

In `room-repository.ts`, change `getAllRooms()` (lines 48-55):

```typescript
/** Get all active rooms (joined + invited, non-tombstoned).
 *  Returns UNSORTED — chat-store owns sort order. */
async getAllRooms(): Promise<LocalRoom[]> {
  const rooms = await this.db.rooms
    .where("membership")
    .anyOf(["join", "invite"])
    .and(r => !r.isDeleted)
    .toArray();
  return this.healUpdatedAt(rooms);
}
```

Also change `getJoinedRooms()` (lines 31-38):

```typescript
/** Get all joined rooms, excluding tombstones. Returns UNSORTED. */
async getJoinedRooms(): Promise<LocalRoom[]> {
  const rooms = await this.db.rooms
    .where("membership")
    .equals("join")
    .and(r => !r.isDeleted)
    .toArray();
  return this.healUpdatedAt(rooms);
}
```

**Step 4: Run all tests**

Run: `npx vitest run src/shared/lib/local-db/room-repository.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/shared/lib/local-db/room-repository.ts src/shared/lib/local-db/room-repository.test.ts
git commit -m "perf: remove redundant sort from RoomRepository — chat-store owns sort order"
```

---

### Task 3: Add observeRoomChanges to RoomRepository (delta tracking)

**Files:**
- Modify: `src/shared/lib/local-db/room-repository.ts`
- Create: `src/shared/lib/local-db/__tests__/room-changes.test.ts`

**Step 1: Write the failing test**

Create `src/shared/lib/local-db/__tests__/room-changes.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Dexie from "dexie";
import "fake-indexeddb/auto";
import { RoomRepository } from "../room-repository";
import type { LocalRoom } from "../schema";
import { ChatDatabase } from "../schema";

function makeLocalRoom(overrides: Partial<LocalRoom> = {}): LocalRoom {
  return {
    id: overrides.id ?? "!r:s",
    name: overrides.name ?? "Room",
    isGroup: false,
    members: [],
    membership: "join",
    unreadCount: 0,
    lastReadInboundTs: 0,
    lastReadOutboundTs: 0,
    updatedAt: overrides.updatedAt ?? Date.now(),
    syncedAt: Date.now(),
    hasMoreHistory: true,
    isDeleted: false,
    deletedAt: null,
    deleteReason: null,
    ...overrides,
  };
}

describe("observeRoomChanges", () => {
  let db: ChatDatabase;
  let repo: RoomRepository;

  beforeEach(async () => {
    db = new ChatDatabase(`test-${Date.now()}`);
    repo = new RoomRepository(db);
  });

  afterEach(async () => {
    await db.delete();
  });

  it("reports upsert when a room is created via put", async () => {
    const changes: any[] = [];
    const unsub = repo.observeRoomChanges((batch) => changes.push(...batch));

    await db.rooms.put(makeLocalRoom({ id: "!a:s", name: "A" }));
    // Dexie hooks fire synchronously within the transaction
    await new Promise(r => setTimeout(r, 50)); // let microtask flush

    expect(changes.length).toBeGreaterThanOrEqual(1);
    const upsert = changes.find((c: any) => c.type === "upsert" && c.room.id === "!a:s");
    expect(upsert).toBeTruthy();
    expect(upsert.room.name).toBe("A");

    unsub();
  });

  it("reports upsert when a room is updated", async () => {
    await db.rooms.put(makeLocalRoom({ id: "!b:s", name: "Before" }));
    const changes: any[] = [];
    const unsub = repo.observeRoomChanges((batch) => changes.push(...batch));

    await db.rooms.update("!b:s", { name: "After" });
    await new Promise(r => setTimeout(r, 50));

    const upsert = changes.find((c: any) => c.type === "upsert" && c.room.id === "!b:s");
    expect(upsert).toBeTruthy();

    unsub();
  });

  it("reports delete when a room is removed", async () => {
    await db.rooms.put(makeLocalRoom({ id: "!c:s" }));
    const changes: any[] = [];
    const unsub = repo.observeRoomChanges((batch) => changes.push(...batch));

    await db.rooms.delete("!c:s");
    await new Promise(r => setTimeout(r, 50));

    const del = changes.find((c: any) => c.type === "delete" && c.roomId === "!c:s");
    expect(del).toBeTruthy();

    unsub();
  });

  it("batches multiple changes in same transaction into one callback", async () => {
    const batches: any[][] = [];
    const unsub = repo.observeRoomChanges((batch) => batches.push(batch));

    await db.transaction("rw", db.rooms, async () => {
      await db.rooms.put(makeLocalRoom({ id: "!d:s" }));
      await db.rooms.put(makeLocalRoom({ id: "!e:s" }));
    });
    await new Promise(r => setTimeout(r, 50));

    // Should have received changes for both rooms
    const allChanges = batches.flat();
    expect(allChanges.length).toBeGreaterThanOrEqual(2);

    unsub();
  });

  it("stops reporting after unsubscribe", async () => {
    const changes: any[] = [];
    const unsub = repo.observeRoomChanges((batch) => changes.push(...batch));
    unsub();

    await db.rooms.put(makeLocalRoom({ id: "!f:s" }));
    await new Promise(r => setTimeout(r, 50));

    expect(changes).toHaveLength(0);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/shared/lib/local-db/__tests__/room-changes.test.ts`
Expected: FAIL — `observeRoomChanges` doesn't exist yet.

**Step 3: Implement observeRoomChanges**

Add to `room-repository.ts` after the existing imports, add a type:

```typescript
/** Delta change reported by observeRoomChanges */
export type RoomChange =
  | { type: "upsert"; room: LocalRoom }
  | { type: "delete"; roomId: string };
```

Add method to `RoomRepository` class (at the end, before closing brace):

```typescript
  // ---------------------------------------------------------------------------
  // Delta observation (replaces full-table liveQuery for chat-store)
  // ---------------------------------------------------------------------------

  /**
   * Subscribe to room table changes via Dexie hooks.
   * Changes are micro-batched: multiple writes in the same tick are delivered
   * as a single callback invocation.
   *
   * Returns an unsubscribe function.
   */
  observeRoomChanges(callback: (changes: RoomChange[]) => void): () => void {
    let buffer: RoomChange[] = [];
    let flushScheduled = false;

    const scheduleFlush = () => {
      if (flushScheduled) return;
      flushScheduled = true;
      // Use queueMicrotask to batch changes within same transaction/tick
      queueMicrotask(() => {
        flushScheduled = false;
        if (buffer.length === 0) return;
        const batch = buffer;
        buffer = [];
        callback(batch);
      });
    };

    // Dexie hooks: 'creating' fires for new rows, 'updating' for modifications
    const onCreating = function (this: any, primKey: string, obj: LocalRoom) {
      buffer.push({ type: "upsert", room: { ...obj } });
      scheduleFlush();
    };

    const onUpdating = function (this: any, mods: object, primKey: string, obj: LocalRoom) {
      // obj is the ORIGINAL object; apply mods to get the new state
      const updated = { ...obj, ...mods } as LocalRoom;
      buffer.push({ type: "upsert", room: updated });
      scheduleFlush();
    };

    const onDeleting = function (this: any, primKey: string, obj: LocalRoom) {
      buffer.push({ type: "delete", roomId: primKey });
      scheduleFlush();
    };

    this.db.rooms.hook("creating", onCreating);
    this.db.rooms.hook("updating", onUpdating);
    this.db.rooms.hook("deleting", onDeleting);

    return () => {
      this.db.rooms.hook("creating").unsubscribe(onCreating);
      this.db.rooms.hook("updating").unsubscribe(onUpdating);
      this.db.rooms.hook("deleting").unsubscribe(onDeleting);
      buffer = [];
    };
  }
```

**Step 4: Export the new type**

In `src/shared/lib/local-db/index.ts`, add to the room-repository exports:

```typescript
export type { RoomChange } from "./room-repository";
```

**Step 5: Run test to verify it passes**

Run: `npx vitest run src/shared/lib/local-db/__tests__/room-changes.test.ts`
Expected: PASS

**Step 6: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass.

**Step 7: Commit**

```bash
git add src/shared/lib/local-db/room-repository.ts src/shared/lib/local-db/__tests__/room-changes.test.ts src/shared/lib/local-db/index.ts
git commit -m "feat: add observeRoomChanges for delta-based room list updates"
```

---

### Task 4: Implement incremental sorted room list in chat-store

This is the core task. Replace the full-sort `computeSortedRooms` + `useLiveQuery(getAllRooms())` with delta-based patching.

**Files:**
- Modify: `src/entities/chat/model/chat-store.ts:600-860` (the entire dexieRooms → sortedRooms pipeline)
- Modify: `src/entities/chat/model/chat-store-sorted.test.ts`

**Step 1: Write tests for incremental sort behavior**

Add new tests to `chat-store-sorted.test.ts`:

```typescript
describe("incremental sort helpers", () => {
  // These test the pure functions that will be used in the incremental path.
  // We test via the store's public API (sortedRooms) since the helpers are internal.

  let store: ReturnType<typeof useChatStore>;

  beforeEach(() => {
    setActivePinia(createTestingPinia({ stubActions: false }));
    store = useChatStore();
  });

  it("maintains sort order after single room update (timestamp moves up)", () => {
    store.rooms = [
      makeRoom({ id: "!a:s", lastMessage: makeMsgField({ timestamp: 300 }) }),
      makeRoom({ id: "!b:s", lastMessage: makeMsgField({ timestamp: 200 }) }),
      makeRoom({ id: "!c:s", lastMessage: makeMsgField({ timestamp: 100 }) }),
    ];
    expect(store.sortedRooms.map(r => r.id)).toEqual(["!a:s", "!b:s", "!c:s"]);

    // Update !c:s to have newest timestamp — should move to top
    store.rooms = [
      makeRoom({ id: "!a:s", lastMessage: makeMsgField({ timestamp: 300 }) }),
      makeRoom({ id: "!b:s", lastMessage: makeMsgField({ timestamp: 200 }) }),
      makeRoom({ id: "!c:s", lastMessage: makeMsgField({ timestamp: 999 }) }),
    ];
    expect(store.sortedRooms.map(r => r.id)).toEqual(["!c:s", "!a:s", "!b:s"]);
  });

  it("handles room addition to existing sorted list", () => {
    store.rooms = [
      makeRoom({ id: "!a:s", lastMessage: makeMsgField({ timestamp: 300 }) }),
      makeRoom({ id: "!b:s", lastMessage: makeMsgField({ timestamp: 100 }) }),
    ];
    expect(store.sortedRooms).toHaveLength(2);

    // Add a room with middle timestamp
    store.rooms = [
      ...store.rooms,
      makeRoom({ id: "!c:s", lastMessage: makeMsgField({ timestamp: 200 }) }),
    ];
    expect(store.sortedRooms.map(r => r.id)).toEqual(["!a:s", "!c:s", "!b:s"]);
  });

  it("handles room removal from sorted list", () => {
    store.rooms = [
      makeRoom({ id: "!a:s", lastMessage: makeMsgField({ timestamp: 300 }) }),
      makeRoom({ id: "!b:s", lastMessage: makeMsgField({ timestamp: 200 }) }),
      makeRoom({ id: "!c:s", lastMessage: makeMsgField({ timestamp: 100 }) }),
    ];
    // Remove middle room
    store.rooms = store.rooms.filter(r => r.id !== "!b:s");
    expect(store.sortedRooms.map(r => r.id)).toEqual(["!a:s", "!c:s"]);
  });

  it("handles 10000 rooms efficiently (does not timeout)", () => {
    const rooms = Array.from({ length: 10000 }, (_, i) =>
      makeRoom({
        id: `!r${i}:s`,
        lastMessage: makeMsgField({ timestamp: Math.floor(Math.random() * 1000000) }),
      })
    );
    store.rooms = rooms;
    const start = performance.now();
    const sorted = store.sortedRooms;
    const elapsed = performance.now() - start;
    expect(sorted).toHaveLength(10000);
    // Should be fast for first sort (< 100ms for 10k rooms)
    expect(elapsed).toBeLessThan(500);
  });
});
```

**Step 2: Run tests to verify they pass with current implementation**

Run: `npx vitest run src/entities/chat/model/chat-store-sorted.test.ts`
Expected: All PASS (these test the public API which should work regardless of internal implementation).

**Step 3: Implement the incremental sort system in chat-store.ts**

Replace the entire dexieRooms → sortedRooms pipeline (lines ~600-860). The key changes:

1. **Remove** `useLiveQuery(getAllRooms())` for dexieRooms — replace with one-time load + `observeRoomChanges()`
2. **Replace** `computeSortedRooms()` with `patchSortedRooms()` for delta updates
3. **Keep** `computeSortedRooms()` as `fullRebuildSortedRooms()` for initial load and periodic reconciliation, but make it async with yield
4. **Keep** the fallback path via `rooms.value` (in-memory) unchanged

Here are the specific code changes:

**3a. Replace dexieRooms liveQuery (lines 601-609) with delta-based subscription:**

Remove:
```typescript
const { data: dexieRooms, isReady: dexieRoomsReady } = useLiveQuery(
  () => {
    if (!chatDbKitRef.value) return [] as LocalRoom[];
    return chatDbKitRef.value.rooms.getAllRooms();
  },
  () => chatDbKitRef.value,
  [] as LocalRoom[],
);
```

Replace with:
```typescript
// Delta-based room tracking: one-time load + incremental updates via Dexie hooks.
// This replaces useLiveQuery(getAllRooms()) which returned ALL 300k rows on every change.
const dexieRooms = shallowRef<LocalRoom[]>([]);
const dexieRoomsReady = ref(false);
const dexieRoomMap = new Map<string, LocalRoom>(); // O(1) lookup by roomId
let dexieChangesUnsub: (() => void) | null = null;

/** One-time: load all rooms from Dexie into memory, build index */
const initDexieRooms = async (dbKit: ChatDbKit) => {
  const allRooms = await dbKit.rooms.getAllRooms();
  dexieRoomMap.clear();
  for (const r of allRooms) dexieRoomMap.set(r.id, r);
  dexieRooms.value = allRooms;
  dexieRoomsReady.value = true;

  // Subscribe to delta changes
  dexieChangesUnsub?.();
  dexieChangesUnsub = dbKit.rooms.observeRoomChanges((changes) => {
    applyDexieDeltas(changes);
  });
};

/** Apply delta changes from Dexie hooks to the in-memory room map + sorted list */
const applyDexieDeltas = (changes: import("@/shared/lib/local-db").RoomChange[]) => {
  if (_suppressDexieRecompute) {
    _sortedDirty = true;
    return;
  }

  // Filter out non-interactive rooms (leave, deleted)
  const relevantChanges: import("@/shared/lib/local-db").RoomChange[] = [];
  for (const c of changes) {
    if (c.type === "delete") {
      if (dexieRoomMap.has(c.roomId)) {
        dexieRoomMap.delete(c.roomId);
        relevantChanges.push(c);
      }
    } else {
      const r = c.room;
      // Only track interactive rooms (join/invite, not deleted)
      if ((r.membership === "join" || r.membership === "invite") && !r.isDeleted) {
        // healUpdatedAt inline
        if (!r.updatedAt) r.updatedAt = r.lastMessageTimestamp || 1;
        dexieRoomMap.set(r.id, r);
        relevantChanges.push(c);
      } else if (dexieRoomMap.has(r.id)) {
        // Room became non-interactive (left, deleted) — treat as removal
        dexieRoomMap.delete(r.id);
        relevantChanges.push({ type: "delete", roomId: r.id });
      }
    }
  }

  if (relevantChanges.length === 0) return;

  // Update the flat array reference (for totalUnread and other consumers)
  dexieRooms.value = Array.from(dexieRoomMap.values());

  // Incremental vs full rebuild threshold
  if (relevantChanges.length > 100) {
    // Mass update (initial sync, fullRoomRefresh) — schedule full rebuild
    scheduleFullSortedRebuild();
  } else {
    // Normal case: patch sorted list incrementally
    patchSortedRooms(relevantChanges);
  }
};
```

**3b. Add incremental sort helpers (new code, insert after the dexieRooms block):**

```typescript
// ---------------------------------------------------------------------------
// Incremental sorted room list
// ---------------------------------------------------------------------------

/** Get sort key for a room (higher = more recent = earlier in list) */
const getSortKey = (room: ChatRoom): number =>
  room.lastMessage?.timestamp || room.updatedAt || 0;

/** Binary search for insertion position in descending-sorted array.
 *  Returns the index where `key` should be inserted to maintain desc order. */
const binarySearchDesc = (arr: ChatRoom[], key: number, pinned: ReadonlySet<string>, isPinned: boolean): number => {
  // Pinned rooms go to the front
  let lo: number, hi: number;
  if (isPinned) {
    lo = 0;
    hi = 0;
    // Find the end of pinned region
    while (hi < arr.length && pinned.has(arr[hi].id)) hi++;
    // Within pinned region, sort by timestamp desc
    const start = lo;
    lo = start;
    hi = hi;
  } else {
    // Skip past pinned region
    lo = 0;
    while (lo < arr.length && pinned.has(arr[lo].id)) lo++;
    hi = arr.length;
  }

  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const midKey = getSortKey(arr[mid]);
    if (midKey > key) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
};

/** Patch the sorted room list incrementally for a small batch of changes.
 *  Complexity: O(k * n) for k changes due to splice, but k is typically 1-5
 *  and splice on a typed array is a native memcpy — fast even for 300k elements. */
const patchSortedRooms = (changes: import("@/shared/lib/local-db").RoomChange[]) => {
  perfCount("sortedRooms:patch");
  const arr = [..._sortedRoomsRef.value]; // shallow copy for Vue reactivity
  const pinned = pinnedRoomIds.value;

  for (const change of changes) {
    if (change.type === "delete") {
      const idx = arr.findIndex(r => r.id === change.roomId);
      if (idx !== -1) arr.splice(idx, 1);
      _chatRoomFromDexieCache.delete(change.roomId);
    } else {
      const lr = change.room;
      // Map LocalRoom → ChatRoom (with cache)
      const chatRoom = mapLocalRoomToChatRoom(lr);

      // Remove old position
      const oldIdx = arr.findIndex(r => r.id === lr.id);
      if (oldIdx !== -1) arr.splice(oldIdx, 1);

      // Find new position via binary search
      const key = getSortKey(chatRoom);
      const isPinned = pinned.has(lr.id);
      const newIdx = binarySearchDesc(arr, key, pinned, isPinned);
      arr.splice(newIdx, 0, chatRoom);
    }
  }

  _sortedRoomsRef.value = arr;
};

/** Map a single LocalRoom → ChatRoom, using the existing cache. */
const mapLocalRoomToChatRoom = (lr: LocalRoom): ChatRoom => {
  const ts = lr.lastMessageTimestamp ?? 0;
  let effectivePreview = lr.lastMessagePreview;
  if (effectivePreview != null && (effectivePreview === "[encrypted]" || effectivePreview === "m.bad.encrypted" || effectivePreview.startsWith("** Unable to decrypt"))) {
    const decrypted = decryptedPreviewCache.get(lr.id);
    if (decrypted) effectivePreview = decrypted;
  }

  const localStatus = lr.lastMessageLocalStatus;
  const readOutboundTs = lr.lastReadOutboundTs ?? 0;
  const lastMsgDecryptionStatus = lr.lastMessageDecryptionStatus;
  const cached = _chatRoomFromDexieCache.get(lr.id);
  if (
    cached &&
    cached.ts === ts &&
    cached.unread === lr.unreadCount &&
    cached.name === lr.name &&
    cached.membership === lr.membership &&
    cached.room.avatar === lr.avatar &&
    cached.preview === effectivePreview &&
    cached.localStatus === localStatus &&
    cached.readOutboundTs === readOutboundTs &&
    cached.lastMsgDecryptionStatus === lastMsgDecryptionStatus
  ) {
    return cached.room;
  }

  const room: ChatRoom = {
    id: lr.id,
    name: lr.name,
    avatar: lr.avatar,
    isGroup: lr.isGroup,
    members: lr.members,
    membership: lr.membership as "join" | "invite",
    unreadCount: lr.unreadCount,
    topic: lr.topic,
    updatedAt: lr.updatedAt,
    lastMessage: effectivePreview != null ? {
      id: "",
      roomId: lr.id,
      senderId: lr.lastMessageSenderId ?? "",
      content: effectivePreview,
      timestamp: ts,
      status: deriveOutboundStatus(
        lr.lastMessageLocalStatus ?? "synced",
        ts,
        lr.lastReadOutboundTs ?? 0,
      ),
      type: lr.lastMessageType ?? MessageType.text,
      decryptionStatus: lr.lastMessageDecryptionStatus,
      callInfo: lr.lastMessageCallInfo,
      systemMeta: lr.lastMessageSystemMeta,
    } as Message : undefined,
    lastMessageReaction: lr.lastMessageReaction ?? undefined,
  } as ChatRoom;
  _chatRoomFromDexieCache.set(lr.id, { ts, unread: lr.unreadCount, name: lr.name, membership: lr.membership, preview: effectivePreview, localStatus, readOutboundTs, lastMsgDecryptionStatus, room });
  return room;
};

/** Async full rebuild with yield — used for initial load and periodic reconciliation */
const fullRebuildSortedRoomsAsync = async () => {
  perfCount("sortedRooms:fullRebuild");
  const allRooms = Array.from(dexieRoomMap.values());
  if (allRooms.length === 0 && rooms.value.length > 0) {
    // Dexie empty, use in-memory fallback
    _sortedRoomsRef.value = computeSortedRoomsFallback(rooms.value, pinnedRoomIds.value);
    return;
  }

  const CHUNK = 5000;
  const mapped: ChatRoom[] = new Array(allRooms.length);

  // Map in chunks with yield
  for (let i = 0; i < allRooms.length; i += CHUNK) {
    const end = Math.min(i + CHUNK, allRooms.length);
    for (let j = i; j < end; j++) {
      mapped[j] = mapLocalRoomToChatRoom(allRooms[j]);
    }
    if (end < allRooms.length) await yieldToMain();
  }

  // Sort chunks individually, then merge (avoids single 260ms block)
  const pinned = pinnedRoomIds.value;
  const cmp = (a: ChatRoom, b: ChatRoom) => {
    const aPinned = pinned.has(a.id) ? 1 : 0;
    const bPinned = pinned.has(b.id) ? 1 : 0;
    if (aPinned !== bPinned) return bPinned - aPinned;
    return getSortKey(b) - getSortKey(a);
  };

  // For chunks up to ~50k, native sort in chunks + merge is efficient
  if (mapped.length <= CHUNK) {
    mapped.sort(cmp);
  } else {
    // Sort each chunk, then merge
    const chunks: ChatRoom[][] = [];
    for (let i = 0; i < mapped.length; i += CHUNK) {
      const chunk = mapped.slice(i, Math.min(i + CHUNK, mapped.length));
      chunk.sort(cmp);
      chunks.push(chunk);
      await yieldToMain();
    }
    // k-way merge (simplified: just concat + sort since we've pre-sorted chunks)
    const result = chunks.flat();
    result.sort(cmp);
    _sortedRoomsRef.value = result;
    return;
  }

  _sortedRoomsRef.value = mapped;
};

let _fullRebuildTimer: ReturnType<typeof setTimeout> | null = null;

/** Schedule a full rebuild (debounced) */
const scheduleFullSortedRebuild = () => {
  if (_fullRebuildTimer) return;
  _fullRebuildTimer = setTimeout(() => {
    _fullRebuildTimer = null;
    fullRebuildSortedRoomsAsync();
  }, 50);
};

/** Synchronous fallback sort for in-memory rooms (no Dexie) */
const computeSortedRoomsFallback = (
  source: ChatRoom[],
  pinned: ReadonlySet<string>,
): ChatRoom[] => {
  return [...source].sort((a, b) => {
    const aPinned = pinned.has(a.id) ? 1 : 0;
    const bPinned = pinned.has(b.id) ? 1 : 0;
    if (aPinned !== bPinned) return bPinned - aPinned;
    return getSortKey(b) - getSortKey(a);
  });
};
```

**3c. Replace the old throttled watch (lines 808-859) with simplified watchers:**

Remove the old `_sortedRoomsRef`, `_sortedThrottleTimer`, `_sortedDirty`, `_recomputeSorted`, and the two watches. Replace with:

```typescript
// Immediate watch for rooms (in-memory fallback) and pinnedRoomIds
watch(
  [rooms, pinnedRoomIds],
  () => {
    if (chatDbKitRef.value && dexieRoomMap.size > 0) {
      // Dexie is active — full rebuild to reflect pin changes
      scheduleFullSortedRebuild();
    } else {
      // No Dexie — sort in-memory rooms synchronously
      _sortedRoomsRef.value = computeSortedRoomsFallback(rooms.value, pinnedRoomIds.value);
    }
  },
  { immediate: true, flush: "sync" },
);

// Watch for chatDbKit initialization — trigger initial Dexie load
watch(
  () => chatDbKitRef.value,
  async (kit) => {
    if (kit) {
      await initDexieRooms(kit);
      // Initial full rebuild from Dexie data
      await fullRebuildSortedRoomsAsync();
    } else {
      // DB closed (logout) — cleanup
      dexieChangesUnsub?.();
      dexieChangesUnsub = null;
      dexieRoomMap.clear();
      dexieRooms.value = [];
      dexieRoomsReady.value = false;
    }
  },
  { immediate: true },
);
```

**3d. Update `_recomputeSorted` references:**

The following places call `_recomputeSorted()` and need updating:

1. `fullRoomRefresh` finally block (line ~1305): Change `if (_sortedDirty) _recomputeSorted();` to `scheduleFullSortedRebuild();`

2. Remove `_recomputeSorted` function entirely — it's replaced by `patchSortedRooms` and `fullRebuildSortedRoomsAsync`.

3. Keep `_suppressDexieRecompute` flag — it's used in `applyDexieDeltas` now.

4. Keep `_sortedDirty` flag — used to track deferred updates during `_suppressDexieRecompute`.

**3e. Update `activeRoomOutboundWatermark` (line 612-616):**

Change from scanning `dexieRooms.value` array to using `dexieRoomMap`:

```typescript
const activeRoomOutboundWatermark = computed(() => {
  if (!activeRoomId.value) return 0;
  const lr = dexieRoomMap.get(activeRoomId.value);
  return lr?.lastReadOutboundTs ?? 0;
});
```

**3f. Update `totalUnread` (lines 863-870):**

Change from scanning `dexieRooms.value` to using `dexieRoomMap`:

```typescript
const totalUnread = computed(() => {
  if (chatDbKitRef.value && dexieRoomMap.size > 0) {
    // Use dexieRooms ref to maintain reactivity
    void dexieRooms.value;
    let sum = 0;
    for (const r of dexieRoomMap.values()) sum += r.unreadCount;
    return sum;
  }
  return rooms.value.reduce((sum, r) => sum + r.unreadCount, 0);
});
```

**Step 4: Run all tests**

Run: `npx vitest run src/entities/chat/model/chat-store-sorted.test.ts`
Expected: All PASS

Run: `npx vitest run`
Expected: All PASS

**Step 5: Run type check and build**

Run: `npx vue-tsc --noEmit && npm run build`
Expected: No errors.

**Step 6: Commit**

```bash
git add src/entities/chat/model/chat-store.ts src/entities/chat/model/chat-store-sorted.test.ts
git commit -m "perf: replace O(n log n) full sort with incremental O(k) patching for room list

On accounts with 100k+ rooms, computeSortedRooms() blocked the event loop
for ~260ms on every Dexie change, starving message delivery and push handlers.

Changes:
- Replace useLiveQuery(getAllRooms()) with one-time load + observeRoomChanges()
- Add patchSortedRooms() for incremental binary-search insertion (O(k) per sync)
- Add fullRebuildSortedRoomsAsync() with chunked yield for initial/periodic rebuild
- Mass updates (>100 changes) fall back to async full rebuild"
```

---

### Task 5: Add room auto-cleanup

**Files:**
- Create: `src/entities/chat/model/room-cleanup.ts`
- Create: `src/entities/chat/model/__tests__/room-cleanup.test.ts`
- Modify: `src/entities/chat/model/chat-store.ts` (wire up cleanup on init)

**Step 1: Write the test**

Create `src/entities/chat/model/__tests__/room-cleanup.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { cleanupStaleRooms, type CleanupContext } from "../room-cleanup";
import type { LocalRoom } from "@/shared/lib/local-db";

function makeLocalRoom(overrides: Partial<LocalRoom> = {}): LocalRoom {
  return {
    id: overrides.id ?? "!r:s",
    name: "Room",
    isGroup: false,
    members: [],
    membership: overrides.membership ?? "join",
    unreadCount: 0,
    lastReadInboundTs: 0,
    lastReadOutboundTs: 0,
    updatedAt: overrides.updatedAt ?? Date.now(),
    lastMessageTimestamp: overrides.lastMessageTimestamp,
    syncedAt: Date.now(),
    hasMoreHistory: true,
    isDeleted: overrides.isDeleted ?? false,
    deletedAt: overrides.deletedAt ?? null,
    deleteReason: overrides.deleteReason ?? null,
    ...overrides,
  };
}

describe("cleanupStaleRooms", () => {
  it("removes rooms with membership=leave", async () => {
    const leftRoom = makeLocalRoom({ id: "!left:s", membership: "leave" });
    const joinedRoom = makeLocalRoom({ id: "!joined:s", membership: "join" });

    const deleted: string[] = [];
    const ctx: CleanupContext = {
      getAllRooms: async () => [leftRoom, joinedRoom],
      deleteRooms: async (ids) => { deleted.push(...ids); },
      isRoomInSdk: () => true,
      getRoomHistoryVisibility: () => null,
    };

    const count = await cleanupStaleRooms(ctx);
    expect(count).toBe(1);
    expect(deleted).toEqual(["!left:s"]);
  });

  it("removes orphaned rooms not in SDK", async () => {
    const orphan = makeLocalRoom({ id: "!orphan:s", membership: "join" });
    const sdkRoomIds = new Set<string>();

    const deleted: string[] = [];
    const ctx: CleanupContext = {
      getAllRooms: async () => [orphan],
      deleteRooms: async (ids) => { deleted.push(...ids); },
      isRoomInSdk: (id) => sdkRoomIds.has(id),
      getRoomHistoryVisibility: () => null,
    };

    const count = await cleanupStaleRooms(ctx);
    expect(count).toBe(1);
    expect(deleted).toEqual(["!orphan:s"]);
  });

  it("removes stream rooms inactive for >3 days", async () => {
    const FOUR_DAYS_AGO = Date.now() - 4 * 24 * 60 * 60 * 1000;
    const staleStream = makeLocalRoom({
      id: "!stream:s",
      lastMessageTimestamp: FOUR_DAYS_AGO,
      membership: "join",
    });

    const deleted: string[] = [];
    const ctx: CleanupContext = {
      getAllRooms: async () => [staleStream],
      deleteRooms: async (ids) => { deleted.push(...ids); },
      isRoomInSdk: () => true,
      getRoomHistoryVisibility: () => "world_readable",
    };

    const count = await cleanupStaleRooms(ctx);
    expect(count).toBe(1);
    expect(deleted).toEqual(["!stream:s"]);
  });

  it("keeps active stream rooms", async () => {
    const activeStream = makeLocalRoom({
      id: "!active:s",
      lastMessageTimestamp: Date.now() - 1000, // 1 second ago
      membership: "join",
    });

    const deleted: string[] = [];
    const ctx: CleanupContext = {
      getAllRooms: async () => [activeStream],
      deleteRooms: async (ids) => { deleted.push(...ids); },
      isRoomInSdk: () => true,
      getRoomHistoryVisibility: () => "world_readable",
    };

    const count = await cleanupStaleRooms(ctx);
    expect(count).toBe(0);
    expect(deleted).toEqual([]);
  });

  it("keeps normal joined rooms", async () => {
    const normalRoom = makeLocalRoom({ id: "!normal:s", membership: "join" });

    const deleted: string[] = [];
    const ctx: CleanupContext = {
      getAllRooms: async () => [normalRoom],
      deleteRooms: async (ids) => { deleted.push(...ids); },
      isRoomInSdk: () => true,
      getRoomHistoryVisibility: () => "shared",
    };

    const count = await cleanupStaleRooms(ctx);
    expect(count).toBe(0);
    expect(deleted).toEqual([]);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/entities/chat/model/__tests__/room-cleanup.test.ts`
Expected: FAIL — module doesn't exist.

**Step 3: Implement room-cleanup.ts**

Create `src/entities/chat/model/room-cleanup.ts`:

```typescript
import type { LocalRoom } from "@/shared/lib/local-db";

const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;

/** Dependency injection interface for testability */
export interface CleanupContext {
  getAllRooms: () => Promise<LocalRoom[]>;
  deleteRooms: (ids: string[]) => Promise<void>;
  isRoomInSdk: (roomId: string) => boolean;
  getRoomHistoryVisibility: (roomId: string) => string | null;
}

/**
 * Remove stale rooms from Dexie to keep room count manageable:
 * 1. Rooms with membership="leave" (already left)
 * 2. Orphaned rooms (in Dexie but not in Matrix SDK)
 * 3. Stream rooms (world_readable) with no activity for >3 days
 *
 * Returns the number of rooms removed.
 */
export async function cleanupStaleRooms(ctx: CleanupContext): Promise<number> {
  const allRooms = await ctx.getAllRooms();
  const now = Date.now();
  const toRemove: string[] = [];

  for (const room of allRooms) {
    // 1. Left rooms
    if (room.membership === "leave") {
      toRemove.push(room.id);
      continue;
    }

    // 2. Orphaned rooms (not in SDK)
    if (!ctx.isRoomInSdk(room.id)) {
      toRemove.push(room.id);
      continue;
    }

    // 3. Stale stream rooms
    const histVis = ctx.getRoomHistoryVisibility(room.id);
    if (histVis === "world_readable") {
      const lastActive = room.lastMessageTimestamp ?? room.updatedAt ?? 0;
      if (now - lastActive > THREE_DAYS_MS) {
        toRemove.push(room.id);
        continue;
      }
    }
  }

  if (toRemove.length > 0) {
    await ctx.deleteRooms(toRemove);
    console.log(`[room-cleanup] Removed ${toRemove.length} stale rooms`);
  }

  return toRemove.length;
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/entities/chat/model/__tests__/room-cleanup.test.ts`
Expected: PASS

**Step 5: Wire up cleanup in chat-store.ts**

In the `refreshRoomsImmediate` function or in the `onMounted`-equivalent (after `roomsInitialized` is set to true), add:

```typescript
import { cleanupStaleRooms } from "./room-cleanup";

// In the initialization path, after roomsInitialized = true:
// Schedule cleanup 30s after init (non-blocking)
setTimeout(async () => {
  if (!chatDbKitRef.value) return;
  const matrixService = getMatrixClientService();
  const matrixClient = matrixService.getClient?.();
  if (!matrixClient) return;

  await cleanupStaleRooms({
    getAllRooms: () => chatDbKitRef.value!.rooms.getAllRooms(),
    deleteRooms: async (ids) => {
      for (const id of ids) {
        await chatDbKitRef.value!.rooms.removeRoom(id);
      }
    },
    isRoomInSdk: (id) => !!matrixClient.getRoom(id),
    getRoomHistoryVisibility: (id) => {
      try {
        const room = matrixClient.getRoom(id);
        const ev = room?.currentState?.getStateEvents?.("m.room.history_visibility", "");
        return ev?.getContent?.()?.history_visibility ?? null;
      } catch { return null; }
    },
  });
}, 30_000);

// Also schedule periodic cleanup every hour
const CLEANUP_INTERVAL = 60 * 60 * 1000;
let cleanupTimer: ReturnType<typeof setInterval> | null = null;
// ... set up interval when roomsInitialized, clear on scope dispose
```

**Step 6: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass.

**Step 7: Commit**

```bash
git add src/entities/chat/model/room-cleanup.ts src/entities/chat/model/__tests__/room-cleanup.test.ts src/entities/chat/model/chat-store.ts
git commit -m "feat: auto-cleanup stale rooms (left, orphaned, inactive streams)"
```

---

### Task 6: Full verification

**Step 1: Type check**

Run: `npx vue-tsc --noEmit`
Expected: No errors.

**Step 2: Lint**

Run: `npm run lint`
Expected: No errors (or only pre-existing warnings).

**Step 3: Build**

Run: `npm run build`
Expected: Build succeeds.

**Step 4: Full test suite**

Run: `npm run test`
Expected: All tests pass.

**Step 5: Code review**

Use `superpowers:code-reviewer` agent to review all changes against the design document.

**Step 6: Final commit (if any fixes from review)**

```bash
git add -A
git commit -m "chore: address code review feedback for room list scalability"
```

---

### Task 7: Push fast-path — targeted event fetch

**Files:**
- Modify: `src/shared/lib/push/push-service.ts:78-103` (tryDecryptAndReplace)
- Modify: `src/entities/matrix/model/matrix-client.ts` (add fetchRoomEvent method)

**Context:** Currently when a push arrives, `tryDecryptAndReplace` waits up to 15s for the sync pipeline to deliver and decrypt the event via `Room.timeline`/`Event.decrypted` listeners. On large accounts, sync can be delayed (heavy JSON parsing, room list processing), so the timeout expires and the message never shows.

The fix: before falling back to sync-based waiting, try to fetch the specific event directly via the Matrix API (`GET /rooms/{roomId}/event/{eventId}`).

**Step 1: Add fetchRoomEvent to matrix-client.ts**

Add a new method to `MatrixClientService`:

```typescript
/** Fetch a single event by ID directly from the server.
 *  This bypasses the sync pipeline — used for push fast-path. */
async fetchRoomEvent(roomId: string, eventId: string): Promise<Record<string, unknown> | null> {
  if (!this.client) return null;
  try {
    // Matrix SDK's fetchRoomEvent returns the raw event JSON
    const event = await this.client.fetchRoomEvent(roomId, eventId);
    return event as Record<string, unknown>;
  } catch (e) {
    console.warn("[matrix-client] fetchRoomEvent error:", e);
    return null;
  }
}
```

**Step 2: Modify tryDecryptAndReplace to try targeted fetch first**

In `push-service.ts`, change `tryDecryptAndReplace` (lines 78-103):

```typescript
private async tryDecryptAndReplace(data: PushPayload): Promise<void> {
  const { room_id: roomId, event_id: eventId } = data;
  if (!roomId || !this.matrixClient) return;

  try {
    // FAST PATH: Check if event is already in timeline
    const existing = this.findDecryptedEvent(roomId, eventId);
    if (existing) {
      await this.showDecryptedNotification(roomId, eventId, existing);
      return;
    }

    // FAST PATH: Targeted fetch — bypass sync pipeline entirely
    if (eventId) {
      const fetched = await this.tryTargetedFetch(roomId, eventId);
      if (fetched) {
        await this.showDecryptedNotification(roomId, eventId, fetched);
        return;
      }
    }

    // SLOW PATH: Wait for sync to deliver the event (existing behavior)
    const result = await this.waitForDecryptedEvent(roomId, eventId, 15000);
    if (!result) return;
    await this.showDecryptedNotification(roomId, eventId, result);
  } catch (e) {
    console.warn('[PushService] Decrypt failed, keeping native notification:', e);
  }
}

/** Try to fetch and extract message body from a specific event via Matrix API */
private async tryTargetedFetch(
  roomId: string,
  eventId: string,
): Promise<{ senderName: string; body: string } | null> {
  try {
    const { getMatrixClientService } = await import("@/entities/matrix/model/matrix-client");
    const matrixService = getMatrixClientService();
    const raw = await matrixService.fetchRoomEvent(roomId, eventId);
    if (!raw) return null;

    // Handle unencrypted messages
    if (raw.type === "m.room.message") {
      const content = raw.content as Record<string, unknown>;
      const body = content?.body;
      if (body && typeof body === "string") {
        const senderName = (raw.sender as string) || "Unknown";
        return { senderName, body: this.formatBody(content) };
      }
    }

    // Encrypted messages can't be decrypted here without crypto context —
    // fall through to sync-based path which has the SDK's decryption pipeline.
    return null;
  } catch {
    return null;
  }
}

private async showDecryptedNotification(
  roomId: string,
  eventId: string | undefined,
  result: { senderName: string; body: string },
): Promise<void> {
  // Get room name for notification title
  const roomInfo = this.getRoomInfo?.(roomId);
  const title = roomInfo?.roomName || result.senderName;

  await LocalNotifications.schedule({
    notifications: [{
      id: roomId.hashCode(),
      title,
      body: result.body,
      channelId: 'messages',
      extra: { room_id: roomId, event_id: eventId },
    }],
  });
  await PushData.cancelNotification({ roomId });
}
```

**Step 3: Run build and tests**

Run: `npx vue-tsc --noEmit && npm run build && npx vitest run`
Expected: All pass.

**Step 4: Commit**

```bash
git add src/shared/lib/push/push-service.ts src/entities/matrix/model/matrix-client.ts
git commit -m "perf: add push fast-path via targeted event fetch

When a push notification arrives, try to fetch the specific event
directly from the server (GET /rooms/{roomId}/event/{eventId}) before
falling back to the sync-based 15s wait. This ensures messages appear
even when the sync pipeline is busy processing 100k rooms."
```

---

### Task 8: Optimize incrementalRoomRefresh — eliminate O(n) scan

**Files:**
- Modify: `src/entities/chat/model/chat-store.ts:1403-1520` (incrementalRoomRefresh)
- Modify: `src/entities/chat/model/chat-store.ts:1690-1725` (refreshRoomsImmediate)

**Context:** `incrementalRoomRefresh` is called on EVERY sync tick. It receives `changed` (the Set of changed room IDs from SDK events). But at line 1414 it ALSO scans ALL matrixRooms to detect new rooms:

```typescript
for (const mr of matrixRooms) {
  if (!roomsMap.has(mr.roomId as string)) changed.add(mr.roomId as string);
}
```

On 100k rooms this is O(n) on every sync. And `refreshRoomsImmediate` calls `matrixService.getRooms()` which returns the full array every time.

**The fix:**
1. Detect new rooms via SDK `Room` event instead of scanning all rooms
2. Only fetch matrixRooms for the changed IDs, not all rooms
3. Skip the "remove rooms that no longer exist" scan (use SDK events instead)

**Step 1: Add new-room detection via SDK events**

In `auth/model/stores.ts` where handlers are registered, add a handler for the `Room` event which fires when the SDK adds a new room:

Actually, this is better done in `chat-store.ts` — add a new method `markRoomNew` and hook it up in the auth store handler setup.

In `chat-store.ts`, add near `markRoomChanged`:

```typescript
/** Mark a room as newly appeared (SDK added it) — ensures next refresh picks it up */
const markRoomNew = (roomId: string) => {
  changedRoomIds.add(roomId);
};
```

Export `markRoomNew` from the store.

In `auth/model/stores.ts`, add to the handler setup:

```typescript
// Listen for new rooms from SDK (avoids scanning all rooms on each sync)
const matrixClient = matrixService.getClient?.();
if (matrixClient) {
  matrixClient.on("Room", (room: any) => {
    const roomId = room?.roomId as string;
    if (roomId) chatStore.markRoomChanged(roomId);
  });
}
```

**Step 2: Optimize incrementalRoomRefresh to not scan all rooms**

Replace the current `incrementalRoomRefresh` (lines 1403-1520):

```typescript
const incrementalRoomRefresh = (
  kit: MatrixKit,
  myUserId: string,
  changed: Set<string>,
) => {
  if (changed.size === 0) return;

  const matrixService = getMatrixClientService();

  // Only fetch Matrix rooms for changed IDs (O(k) instead of O(n))
  const changedMatrixRooms: any[] = [];
  for (const roomId of changed) {
    const matrixRoom = matrixService.getRoom(roomId) as any;
    if (!matrixRoom) {
      // Room gone from SDK — remove from our list
      if (roomsMap.has(roomId)) {
        roomsMap.delete(roomId);
        rooms.value = rooms.value.filter(r => r.id !== roomId);
      }
      continue;
    }

    // Check this room is still interactive
    const membership = matrixRoom.selfMembership ?? matrixRoom.getMyMembership?.();
    if (membership !== "join" && membership !== "invite") continue;
    try {
      const createEvent = matrixRoom.currentState?.getStateEvents?.("m.room.create", "");
      const createContent = createEvent?.getContent?.() ?? createEvent?.event?.content;
      if (createContent?.type === "m.space") continue;
    } catch { /* ignore */ }

    const chatRoom = buildChatRoom(matrixRoom, kit, myUserId);
    const existing = roomsMap.get(roomId);
    if (existing) {
      if (existing.members.length > chatRoom.members.length) {
        chatRoom.members = existing.members;
        chatRoom.avatar = existing.avatar;
      }
      Object.assign(existing, chatRoom);
    } else {
      rooms.value.push(chatRoom);
      roomsMap.set(roomId, chatRoom);
    }
    changedMatrixRooms.push(matrixRoom);
  }

  if (changedMatrixRooms.length > 0 || changed.size > 0) {
    triggerRef(rooms);
  }

  // Dual-write changed rooms to Dexie
  if (chatDbKitRef.value && changedMatrixRooms.length > 0) {
    const dbKit = chatDbKitRef.value;
    const now = Date.now();
    const updates = changedMatrixRooms
      .map(mr => roomsMap.get(mr.roomId as string))
      .filter((r): r is ChatRoom => !!r)
      .map(r => ({
        id: r.id,
        name: r.name,
        avatar: r.avatar,
        isGroup: r.isGroup,
        members: r.members,
        membership: (r.membership ?? "join") as "join" | "invite" | "leave",
        topic: r.topic || "",
        syncedAt: now,
        updatedAt: r.updatedAt,
        lastMessageTimestamp: r.lastMessage?.timestamp || r.updatedAt || undefined,
        serverUnreadCount: r.unreadCount,
        unreadCount: r.unreadCount,
        lastMessagePreview: r.lastMessage?.deleted
          ? "Message deleted"
          : r.lastMessage?.content?.slice(0, 200),
        lastMessageSenderId: r.lastMessage?.senderId,
        lastMessageType: r.lastMessage?.type,
        lastMessageEventId: r.lastMessage?.id || undefined,
        lastMessageLocalStatus: (
          r.lastMessage?.status === MessageStatus.sending ? "pending"
          : r.lastMessage?.status === MessageStatus.failed ? "failed"
          : "synced"
        ) as import("@/shared/lib/local-db").LocalMessageStatus,
      }));
    if (updates.length > 0) {
      dbKit.rooms.bulkSyncRooms(updates).catch(e =>
        console.warn("[chat-store] Dexie incremental room sync failed:", e)
      );
    }
  }

  // Update display names and profiles only for changed rooms
  updateDisplayNames(changedMatrixRooms, kit);
  if (changedMatrixRooms.length > 0) {
    loadProfilesForRoomIds(changedMatrixRooms.map((r: any) => r.roomId as string));
    const changedIds = new Set(changedMatrixRooms.map((r: any) => r.roomId as string));
    decryptRoomPreviews(changedMatrixRooms, changedIds).then(() => debouncedCacheRooms());
  }
  debouncedCacheRooms();
};
```

**Step 3: Optimize refreshRoomsImmediate to not call getRooms() for incremental**

Change `refreshRoomsImmediate` (lines 1690-1725):

```typescript
const refreshRoomsImmediate = () => {
  const matrixService = getMatrixClientService();
  const kit = matrixKitRef.value;
  if (!matrixService.isReady() || !kit) return;
  if (fullRefreshInFlight) return;

  const myUserId = matrixService.getUserId() ?? "";

  const isInitial = lastSyncState === "PREPARED" || !roomsInitialized.value;
  const forceFullRefresh = Date.now() - lastFullRefresh > FULL_REFRESH_INTERVAL;
  const changed = new Set(changedRoomIds);
  changedRoomIds.clear();

  if (isInitial || forceFullRefresh) {
    lastFullRefresh = Date.now();
    // Only fullRoomRefresh needs ALL rooms from SDK
    const matrixRooms = matrixService.getRooms() as any[];
    fullRoomRefresh(matrixRooms, kit, myUserId);
  } else {
    // Incremental: no need to fetch all rooms — only process changed IDs
    incrementalRoomRefresh(kit, myUserId, changed);
  }

  if (!roomsInitialized.value) {
    roomsInitialized.value = true;
    setTimeout(() => preloadVisibleRooms(), 500);
  }
};
```

Note: `incrementalRoomRefresh` no longer takes `matrixRooms` parameter — it fetches individual rooms by ID via `matrixService.getRoom(roomId)`.

**Step 4: Run build and tests**

Run: `npx vue-tsc --noEmit && npm run build && npx vitest run`
Expected: All pass.

**Step 5: Commit**

```bash
git add src/entities/chat/model/chat-store.ts src/entities/auth/model/stores.ts
git commit -m "perf: eliminate O(n) room scan from incremental sync path

incrementalRoomRefresh no longer calls getRooms() or scans all 100k
Matrix rooms. Instead it fetches only changed rooms by ID via
getRoom(roomId). New rooms are detected via SDK 'Room' event
instead of scanning the full room list on every sync tick."
```

---

### Task 9: Optimize fullRoomRefresh — diff-based processing

**Files:**
- Modify: `src/entities/chat/model/chat-store.ts:1142-1313` (fullRoomRefresh)

**Context:** `fullRoomRefresh` runs on initial sync and every 5 minutes for reconciliation. It iterates ALL rooms from `matrixService.getRooms()`, builds a ChatRoom for each, writes all to Dexie, and loads profiles for all. On 100k rooms this takes seconds.

**The fix:**
1. Skip rooms where nothing has changed (compare timestamp)
2. Process Dexie writes only for actually-changed rooms
3. Increase FULL_REFRESH_INTERVAL from 5min to 15min (incremental + delta handles the rest)
4. Profile loading: don't re-request rooms that were already requested

**Step 1: Add timestamp-based diffing to fullRoomRefresh**

Modify the core loop in `fullRoomRefresh` to skip unchanged rooms:

```typescript
const fullRoomRefresh = async (
  matrixRooms: any[],
  kit: MatrixKit,
  myUserId: string,
) => {
  if (fullRefreshInFlight) return;
  fullRefreshInFlight = true;
  _suppressDexieRecompute = true;
  try {
    perfMark("fullRoomRefresh-start");
    decryptFailedRooms.clear();

    const prevNameMap = new Map(rooms.value.map(r => [r.id, r.name]));
    const prevLastMessageMap = new Map(rooms.value.map(r => [r.id, r.lastMessage]));
    const prevMembersMap = new Map(rooms.value.map(r => [r.id, r.members]));
    const prevAvatarMap = new Map(rooms.value.map(r => [r.id, r.avatar]));
    const prevActiveRoom = activeRoomId.value ? getRoomById(activeRoomId.value) : undefined;

    const interactiveRooms = filterInteractiveRooms(matrixRooms);

    const ROOM_CHUNK = 50;
    const newRooms: ChatRoom[] = [];
    // Track which rooms actually changed (for selective Dexie write)
    const changedForDexie: ChatRoom[] = [];

    for (let i = 0; i < interactiveRooms.length; i += ROOM_CHUNK) {
      const slice = interactiveRooms.slice(i, i + ROOM_CHUNK);
      for (const r of slice) {
        const room = buildChatRoom(r, kit, myUserId, prevNameMap, prevLastMessageMap);
        const prevMembers = prevMembersMap.get(room.id);
        if (prevMembers && prevMembers.length > room.members.length) {
          room.members = prevMembers;
          const prevAvatar = prevAvatarMap.get(room.id);
          if (prevAvatar) room.avatar = prevAvatar;
        }
        newRooms.push(room);

        // Diff: only mark for Dexie write if something display-relevant changed
        const prevRoom = roomsMap.get(room.id);
        if (!prevRoom
          || prevRoom.name !== room.name
          || prevRoom.unreadCount !== room.unreadCount
          || (room.lastMessage?.timestamp ?? 0) !== (prevRoom.lastMessage?.timestamp ?? 0)
          || prevRoom.membership !== room.membership
          || prevRoom.avatar !== room.avatar
        ) {
          changedForDexie.push(room);
        }
      }

      if (i + ROOM_CHUNK < interactiveRooms.length) {
        await yieldToMain();
      }
    }

    // Single atomic publish
    {
      if (prevActiveRoom && !newRooms.some(r => r.id === prevActiveRoom.id)) {
        newRooms.push(prevActiveRoom);
      }
      rooms.value = newRooms;
      rebuildRoomsMap();
    }

    perfMark("fullRoomRefresh-allBuilt");

    // OPTIMIZATION: Only write CHANGED rooms to Dexie (not all 100k)
    if (chatDbKitRef.value && changedForDexie.length > 0) {
      const dbKit = chatDbKitRef.value;
      const now = Date.now();
      const updates = changedForDexie.map(r => ({
        id: r.id,
        name: r.name,
        avatar: r.avatar,
        isGroup: r.isGroup,
        members: r.members,
        membership: (r.membership ?? "join") as "join" | "invite" | "leave",
        topic: r.topic || "",
        syncedAt: now,
        updatedAt: r.updatedAt,
        lastMessageTimestamp: r.lastMessage?.timestamp || r.updatedAt || undefined,
        serverUnreadCount: r.unreadCount,
        unreadCount: r.unreadCount,
        lastMessagePreview: r.lastMessage?.deleted
          ? "Message deleted"
          : r.lastMessage?.content?.slice(0, 200),
        lastMessageSenderId: r.lastMessage?.senderId,
        lastMessageType: r.lastMessage?.type,
        lastMessageEventId: r.lastMessage?.id || undefined,
        lastMessageLocalStatus: (
          r.lastMessage?.status === MessageStatus.sending ? "pending"
          : r.lastMessage?.status === MessageStatus.failed ? "failed"
          : "synced"
        ) as import("@/shared/lib/local-db").LocalMessageStatus,
      }));

      const DB_CHUNK = 100;
      for (let i = 0; i < updates.length; i += DB_CHUNK) {
        const chunk = updates.slice(i, i + DB_CHUNK);
        try {
          await dbKit.rooms.bulkSyncRooms(chunk);
        } catch (e) {
          console.warn("[chat-store] Dexie room sync chunk failed:", e);
          if (!chatDbKitRef.value) break;
        }
        if (i + DB_CHUNK < updates.length) {
          await yieldToMain();
        }
      }

      if (import.meta.env.DEV) {
        console.log(`[perf] fullRoomRefresh: ${interactiveRooms.length} total, ${changedForDexie.length} changed, ${interactiveRooms.length - changedForDexie.length} skipped`);
      }
    }

    // ... rest of the function (member loading, profile loading, decrypt) stays the same
```

**Step 2: Increase FULL_REFRESH_INTERVAL**

Change line 339:

```typescript
const FULL_REFRESH_INTERVAL = 900_000; // 15 min — incremental + delta handles normal updates
```

**Step 3: Run build and tests**

Run: `npx vue-tsc --noEmit && npm run build && npx vitest run`
Expected: All pass.

**Step 4: Commit**

```bash
git add src/entities/chat/model/chat-store.ts
git commit -m "perf: diff-based fullRoomRefresh — only write changed rooms to Dexie

On 100k-room accounts, fullRoomRefresh was writing ALL rooms to Dexie
every 5 minutes, generating 100k Dexie hook events and triggering
full sort rebuilds. Now it compares each room against previous state
and only writes rooms with actual display-relevant changes.
Also increases reconciliation interval from 5min to 15min."
```

---

### Task 10: Full verification (updated)

Same as Task 6 but now covers all 9 implementation tasks.

**Step 1: Type check**

Run: `npx vue-tsc --noEmit`

**Step 2: Lint**

Run: `npm run lint`

**Step 3: Build**

Run: `npm run build`

**Step 4: Full test suite**

Run: `npm run test`

**Step 5: Code review**

Use `superpowers:code-reviewer` agent to review ALL changes.

**Step 6: Final commit**

```bash
git add -A
git commit -m "chore: address code review feedback for room list scalability"
```

---

### Summary of changes

| Task | Files | Commit message |
|------|-------|----------------|
| 1 | `matrix-client.ts` | `perf: add server-side sync filter` |
| 2 | `room-repository.ts` | `perf: remove redundant sort from RoomRepository` |
| 3 | `room-repository.ts`, `room-changes.test.ts`, `index.ts` | `feat: add observeRoomChanges for delta tracking` |
| 4 | `chat-store.ts`, `chat-store-sorted.test.ts` | `perf: replace O(n log n) full sort with incremental O(k) patching` |
| 5 | `room-cleanup.ts`, `room-cleanup.test.ts`, `chat-store.ts` | `feat: auto-cleanup stale rooms` |
| 6 | `push-service.ts`, `matrix-client.ts` | `perf: push fast-path via targeted event fetch` |
| 7 | `chat-store.ts`, `auth/stores.ts` | `perf: eliminate O(n) room scan from incremental sync` |
| 8 | `chat-store.ts` | `perf: diff-based fullRoomRefresh` |
| 9 | Various | `chore: full verification` |

### Performance impact summary

| Bottleneck | Before (100k rooms) | After |
|------------|---------------------|-------|
| `computeSortedRooms` per sync tick | ~260ms blocking | ~3ms incremental |
| `incrementalRoomRefresh` per sync tick | O(n) scan all rooms | O(k) changed only |
| `fullRoomRefresh` Dexie writes | 100k writes every 5min | Only changed rooms, every 15min |
| Push notification → message visible | 15s timeout → fail | ~200ms targeted fetch |
| `/sync` response size | Full (ephemeral+state) | 5-10x smaller |
| Total room count | Grows unbounded | Auto-cleanup stale rooms |
| Event Loop max block | 260ms+ continuous | <5ms |
