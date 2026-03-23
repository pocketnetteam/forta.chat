# Performance: Eliminate Cascading Recomputes (Phase 0 + Phase 1)

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Eliminate 4 root causes of UI jank: N individual Dexie writes triggering N liveQuery notifications, sortedRooms allocating 2N objects per recompute, decryptRoomPreviews triggering 4 cascading triggerRef calls, and event handlers firing before rooms are initialized.

**Architecture:** Each optimization is independent and wrapped in a kill-switch (localStorage flag). Changes are purely internal — no API surface or component interface changes. All modifications target `chat-store.ts` and `room-repository.ts`.

**Tech Stack:** Vue 3 (shallowRef, computed, triggerRef), Pinia, Dexie 4 (IndexedDB transactions, liveQuery), Vitest

---

## Pre-requisites

- Working directory: `/Users/daniilkim/work/new-bastyon-chat`
- Run tests: `npm run test`
- Type check: `npx vue-tsc --noEmit`
- Build: `npm run build`
- Lint: `npm run lint`

## Key Files

| File | Role |
|------|------|
| `src/entities/chat/model/chat-store.ts` | Main Pinia store (4091 lines) — sortedRooms, fullRoomRefresh, decryptRoomPreviews |
| `src/shared/lib/local-db/room-repository.ts` | Dexie room CRUD (244 lines) — getAllRooms, updateRoom, upsertRoom |
| `src/entities/auth/model/stores.ts` | Matrix event wiring — onTimeline, onSync handlers |
| `src/entities/chat/model/chat-store.test.ts` | Existing store tests |
| `src/test-utils/factories.ts` | makeMsg, makeRoom factories |

---

## Task 1: Performance Instrumentation Module

**Files:**
- Create: `src/shared/lib/perf-markers.ts`
- Test: `src/shared/lib/perf-markers.test.ts`

**Step 1: Write the test**

```typescript
// src/shared/lib/perf-markers.test.ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { perfMark, perfMeasure, perfCount, getPerfCounts, resetPerfCounts } from "./perf-markers";

describe("perf-markers", () => {
  beforeEach(() => {
    resetPerfCounts();
    performance.clearMarks();
    performance.clearMeasures();
  });

  it("perfMark creates a performance mark", () => {
    perfMark("test-start");
    const marks = performance.getEntriesByName("perf:test-start", "mark");
    expect(marks).toHaveLength(1);
  });

  it("perfMeasure creates a performance measure", () => {
    perfMark("m-start");
    perfMark("m-end");
    const duration = perfMeasure("m", "m-start", "m-end");
    expect(duration).toBeGreaterThanOrEqual(0);
  });

  it("perfCount increments a named counter", () => {
    perfCount("dexie-writes");
    perfCount("dexie-writes");
    perfCount("dexie-writes");
    expect(getPerfCounts().get("dexie-writes")).toBe(3);
  });

  it("resetPerfCounts clears all counters", () => {
    perfCount("foo");
    resetPerfCounts();
    expect(getPerfCounts().size).toBe(0);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/shared/lib/perf-markers.test.ts`
Expected: FAIL — module not found

**Step 3: Write the implementation**

```typescript
// src/shared/lib/perf-markers.ts

const counts = new Map<string, number>();
const WARN_THRESHOLD_MS = 16; // 1 frame

export function perfMark(label: string): void {
  performance.mark(`perf:${label}`);
}

export function perfMeasure(name: string, startLabel: string, endLabel: string): number {
  try {
    performance.measure(`perf:${name}`, `perf:${startLabel}`, `perf:${endLabel}`);
    const entry = performance.getEntriesByName(`perf:${name}`).pop();
    const duration = entry?.duration ?? 0;
    if (duration > WARN_THRESHOLD_MS) {
      console.warn(`[PERF] ${name}: ${duration.toFixed(1)}ms`);
    }
    return duration;
  } catch {
    return 0;
  }
}

export function perfCount(name: string): void {
  counts.set(name, (counts.get(name) ?? 0) + 1);
}

export function getPerfCounts(): ReadonlyMap<string, number> {
  return counts;
}

export function resetPerfCounts(): void {
  counts.clear();
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/shared/lib/perf-markers.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/shared/lib/perf-markers.ts src/shared/lib/perf-markers.test.ts
git commit -m "feat: add lightweight performance instrumentation module"
```

---

## Task 2: Dexie Bulk Write in Transaction (room-repository)

**Problem:** `fullRoomRefresh` (chat-store.ts:773-843) calls `updateRoom()`/`upsertRoom()` individually for each of N rooms. Each write is a separate IndexedDB transaction, generating N separate liveQuery notifications → N sortedRooms recomputes.

**Solution:** Add `bulkSyncRooms()` that wraps all writes in one Dexie transaction → 1 liveQuery notification.

**Files:**
- Modify: `src/shared/lib/local-db/room-repository.ts` (add method)
- Test: `src/shared/lib/local-db/room-repository.test.ts` (create)

**Step 1: Write the test**

```typescript
// src/shared/lib/local-db/room-repository.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Dexie from "dexie";
import "fake-indexeddb/auto";
import { RoomRepository } from "./room-repository";
import type { LocalRoom } from "./schema";

// Minimal in-memory Dexie for testing
class TestDb extends Dexie {
  rooms!: import("dexie").Table<LocalRoom, string>;
  constructor() {
    super("test-room-repo", { indexedDB: indexedDB, IDBKeyRange: IDBKeyRange });
    this.version(1).stores({
      rooms: "id, membership, updatedAt, isDeleted",
    });
  }
}

function makeLocalRoom(overrides: Partial<LocalRoom> = {}): LocalRoom {
  return {
    id: overrides.id ?? `!room_${Math.random().toString(36).slice(2)}:s`,
    name: "Test Room",
    isGroup: false,
    members: ["user1"],
    membership: "join",
    unreadCount: 0,
    updatedAt: Date.now(),
    hasMoreHistory: true,
    lastReadInboundTs: 0,
    lastReadOutboundTs: 0,
    isDeleted: false,
    deletedAt: null,
    deleteReason: null,
    ...overrides,
  } as LocalRoom;
}

describe("RoomRepository", () => {
  let db: TestDb;
  let repo: RoomRepository;

  beforeEach(() => {
    db = new TestDb();
    repo = new RoomRepository(db as any);
  });

  afterEach(async () => {
    await db.delete();
  });

  describe("bulkSyncRooms", () => {
    it("inserts new rooms in a single transaction", async () => {
      const rooms = [
        makeLocalRoom({ id: "!r1:s", name: "Room 1" }),
        makeLocalRoom({ id: "!r2:s", name: "Room 2" }),
        makeLocalRoom({ id: "!r3:s", name: "Room 3" }),
      ];
      await repo.bulkSyncRooms(rooms);
      const all = await repo.getAllRooms();
      expect(all).toHaveLength(3);
    });

    it("updates existing rooms without overwriting preview fields", async () => {
      // Pre-populate with preview data
      await db.rooms.put(makeLocalRoom({
        id: "!r1:s",
        name: "Old Name",
        lastMessagePreview: "Hello there",
        lastMessageTimestamp: 1000,
        unreadCount: 5,
      }));

      // bulkSync with metadata-only update
      await repo.bulkSyncRooms([{
        id: "!r1:s",
        name: "New Name",
        avatar: "mxc://new",
        isGroup: true,
        members: ["a", "b"],
        membership: "join",
        topic: "Updated",
        syncedAt: Date.now(),
      }]);

      const room = await repo.getRoom("!r1:s");
      expect(room!.name).toBe("New Name");
      // Preview fields preserved
      expect(room!.lastMessagePreview).toBe("Hello there");
      expect(room!.lastMessageTimestamp).toBe(1000);
      expect(room!.unreadCount).toBe(5);
    });

    it("revives tombstoned rooms", async () => {
      await db.rooms.put(makeLocalRoom({
        id: "!dead:s",
        isDeleted: true,
        deletedAt: Date.now(),
        deleteReason: "left",
        membership: "leave",
      }));

      await repo.bulkSyncRooms([{
        id: "!dead:s",
        name: "Revived",
        membership: "join",
        isGroup: false,
        members: ["a"],
        syncedAt: Date.now(),
      }]);

      const room = await repo.getRoom("!dead:s");
      expect(room!.isDeleted).toBe(false);
      expect(room!.name).toBe("Revived");
      expect(room!.membership).toBe("join");
    });

    it("monotonically advances updatedAt and lastMessageTimestamp", async () => {
      await db.rooms.put(makeLocalRoom({
        id: "!r1:s",
        updatedAt: 5000,
        lastMessageTimestamp: 4000,
      }));

      // Try to sync with older timestamps — should NOT regress
      await repo.bulkSyncRooms([{
        id: "!r1:s",
        name: "Updated",
        membership: "join",
        isGroup: false,
        members: [],
        syncedAt: Date.now(),
        updatedAt: 3000,              // older than existing
        lastMessageTimestamp: 2000,    // older than existing
      }]);

      const room = await repo.getRoom("!r1:s");
      expect(room!.updatedAt).toBe(5000);              // preserved
      expect(room!.lastMessageTimestamp).toBe(4000);    // preserved
    });
  });

  describe("getAllRooms", () => {
    it("returns joined and invited rooms sorted by timestamp desc", async () => {
      await db.rooms.bulkPut([
        makeLocalRoom({ id: "!old:s", lastMessageTimestamp: 100, membership: "join" }),
        makeLocalRoom({ id: "!new:s", lastMessageTimestamp: 300, membership: "join" }),
        makeLocalRoom({ id: "!mid:s", lastMessageTimestamp: 200, membership: "join" }),
      ]);
      const rooms = await repo.getAllRooms();
      expect(rooms.map(r => r.id)).toEqual(["!new:s", "!mid:s", "!old:s"]);
    });

    it("sorts invites below joined rooms", async () => {
      await db.rooms.bulkPut([
        makeLocalRoom({ id: "!invite:s", lastMessageTimestamp: 9999, membership: "invite" }),
        makeLocalRoom({ id: "!joined:s", lastMessageTimestamp: 100, membership: "join" }),
      ]);
      const rooms = await repo.getAllRooms();
      expect(rooms[0].id).toBe("!joined:s");
      expect(rooms[1].id).toBe("!invite:s");
    });

    it("excludes tombstoned rooms", async () => {
      await db.rooms.bulkPut([
        makeLocalRoom({ id: "!alive:s", membership: "join" }),
        makeLocalRoom({ id: "!dead:s", membership: "join", isDeleted: true }),
      ]);
      const rooms = await repo.getAllRooms();
      expect(rooms).toHaveLength(1);
      expect(rooms[0].id).toBe("!alive:s");
    });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/shared/lib/local-db/room-repository.test.ts`
Expected: FAIL — `bulkSyncRooms` is not a function

Note: You may need to install `fake-indexeddb`: `npm install --save-dev fake-indexeddb`

**Step 3: Implement bulkSyncRooms**

Add this method to `RoomRepository` class in `src/shared/lib/local-db/room-repository.ts`, after the existing `bulkUpsertRooms` method (after line 77):

```typescript
  /** Bulk-sync room metadata in a SINGLE Dexie transaction.
   *  - Existing rooms: update metadata only (preserve preview/unread/watermark fields)
   *  - Tombstoned rooms: revive + update metadata
   *  - New rooms: full insert with initial state
   *  One transaction = one liveQuery notification (instead of N). */
  async bulkSyncRooms(
    roomUpdates: Array<{
      id: string;
      name?: string;
      avatar?: string;
      isGroup?: boolean;
      members?: string[];
      membership?: "join" | "invite" | "leave";
      topic?: string;
      syncedAt?: number;
      updatedAt?: number;
      lastMessageTimestamp?: number;
      // Full insert fields (only for genuinely new rooms)
      unreadCount?: number;
      hasMoreHistory?: boolean;
      lastReadInboundTs?: number;
      lastReadOutboundTs?: number;
      lastMessagePreview?: string;
      lastMessageSenderId?: string;
      lastMessageType?: import("@/entities/chat/model/types").MessageType;
      lastMessageEventId?: string;
      lastMessageLocalStatus?: import("./schema").LocalMessageStatus;
      lastMessageReaction?: import("./schema").LocalRoom["lastMessageReaction"];
      isDeleted?: boolean;
      deletedAt?: number | null;
      deleteReason?: "left" | "kicked" | "banned" | "removed" | null;
    }>,
  ): Promise<void> {
    await this.db.transaction("rw", this.db.rooms, async () => {
      // Pre-fetch all existing rooms in one query
      const ids = roomUpdates.map(r => r.id);
      const existing = await this.db.rooms.bulkGet(ids);
      const existingMap = new Map<string, LocalRoom>();
      for (let i = 0; i < ids.length; i++) {
        if (existing[i]) existingMap.set(ids[i], existing[i]!);
      }

      for (const update of roomUpdates) {
        const ex = existingMap.get(update.id);

        if (ex) {
          // Existing room (possibly tombstoned): update metadata, preserve preview fields
          const changes: Partial<LocalRoom> = {};
          if (update.name !== undefined) changes.name = update.name;
          if (update.avatar !== undefined) changes.avatar = update.avatar;
          if (update.isGroup !== undefined) changes.isGroup = update.isGroup;
          if (update.members !== undefined) changes.members = update.members;
          if (update.membership !== undefined) changes.membership = update.membership;
          if (update.topic !== undefined) changes.topic = update.topic;
          if (update.syncedAt !== undefined) changes.syncedAt = update.syncedAt;

          // Revive if tombstoned
          if (ex.isDeleted) {
            changes.isDeleted = false;
            changes.deletedAt = null;
            changes.deleteReason = null;
          }

          // Monotonically advance timestamps
          if (update.updatedAt && update.updatedAt > (ex.updatedAt ?? 0)) {
            changes.updatedAt = update.updatedAt;
          }
          if (update.lastMessageTimestamp && update.lastMessageTimestamp > (ex.lastMessageTimestamp ?? 0)) {
            changes.lastMessageTimestamp = update.lastMessageTimestamp;
          }

          await this.db.rooms.update(update.id, changes);
        } else {
          // Genuinely new room: full insert
          await this.db.rooms.put({
            id: update.id,
            name: update.name ?? "",
            avatar: update.avatar,
            isGroup: update.isGroup ?? false,
            members: update.members ?? [],
            membership: (update.membership ?? "join") as "join" | "invite" | "leave",
            topic: update.topic ?? "",
            syncedAt: update.syncedAt ?? Date.now(),
            unreadCount: update.unreadCount ?? 0,
            updatedAt: update.updatedAt ?? 0,
            hasMoreHistory: update.hasMoreHistory ?? true,
            lastReadInboundTs: update.lastReadInboundTs ?? 0,
            lastReadOutboundTs: update.lastReadOutboundTs ?? 0,
            lastMessagePreview: update.lastMessagePreview,
            lastMessageTimestamp: update.lastMessageTimestamp,
            lastMessageSenderId: update.lastMessageSenderId,
            lastMessageType: update.lastMessageType,
            lastMessageEventId: update.lastMessageEventId,
            lastMessageLocalStatus: update.lastMessageLocalStatus,
            lastMessageReaction: update.lastMessageReaction ?? null,
            isDeleted: false,
            deletedAt: null,
            deleteReason: null,
          } as LocalRoom);
        }
      }
    });
  }
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/shared/lib/local-db/room-repository.test.ts`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add src/shared/lib/local-db/room-repository.ts src/shared/lib/local-db/room-repository.test.ts
git commit -m "feat: add bulkSyncRooms for single-transaction room metadata sync"
```

---

## Task 3: Wire bulkSyncRooms into fullRoomRefresh

**Problem:** `fullRoomRefresh` (chat-store.ts:773-843) uses N individual writes in a fire-and-forget IIFE.

**Solution:** Replace the IIFE with a call to `bulkSyncRooms`.

**Files:**
- Modify: `src/entities/chat/model/chat-store.ts:771-843`

**Step 1: Replace Dexie dual-write in fullRoomRefresh**

In `chat-store.ts`, replace lines 771-843 (the `if (chatDbKitRef.value) { ... }` block with its entire IIFE) with:

```typescript
    // Dual-write: sync room metadata to Dexie in a single transaction.
    // Single transaction = single liveQuery notification (instead of N).
    // IMPORTANT: Only update metadata fields (name, avatar, members, etc.).
    // Preview/unread/watermark fields are managed exclusively by EventWriter.
    if (chatDbKitRef.value) {
      const dbKit = chatDbKitRef.value;
      const now = Date.now();
      const updates = newRooms.map(r => ({
        id: r.id,
        name: r.name,
        avatar: r.avatar,
        isGroup: r.isGroup,
        members: r.members,
        membership: (r.membership ?? "join") as "join" | "invite" | "leave",
        topic: r.topic || "",
        syncedAt: now,
        updatedAt: r.updatedAt,
        lastMessageTimestamp: r.lastMessage?.timestamp,
        // Full insert fields for genuinely new rooms
        unreadCount: r.unreadCount,
        lastMessagePreview: r.lastMessage?.deleted
          ? "🚫 Message deleted"
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
      dbKit.rooms.bulkSyncRooms(updates).catch(e =>
        console.warn("[chat-store] Dexie room sync failed:", e)
      );
    }
```

**Step 2: Replace Dexie dual-write in incrementalRoomRefresh**

In `chat-store.ts`, replace lines 1028-1100 (the `if (chatDbKitRef.value && changed.size > 0) { ... }` block with its entire IIFE) with:

```typescript
    // Dual-write changed rooms to Dexie in a single transaction
    if (chatDbKitRef.value && changed.size > 0) {
      const dbKit = chatDbKitRef.value;
      const now = Date.now();
      const updates = [...changed]
        .map(roomId => roomsMap.get(roomId))
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
          lastMessageTimestamp: r.lastMessage?.timestamp,
          unreadCount: r.unreadCount,
          lastMessagePreview: r.lastMessage?.deleted
            ? "🚫 Message deleted"
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
```

**Step 3: Run existing tests + type check**

Run: `npx vitest run && npx vue-tsc --noEmit`
Expected: ALL PASS, no type errors

**Step 4: Commit**

```bash
git add src/entities/chat/model/chat-store.ts
git commit -m "perf: use bulkSyncRooms for single-transaction Dexie writes

Replaces N individual room writes with one Dexie transaction,
reducing liveQuery notifications from N to 1 per refresh cycle."
```

---

## Task 4: sortedRooms Structural Sharing

**Problem:** `sortedRooms` computed (chat-store.ts:587-634) creates N new ChatRoom objects + a spread copy on EVERY recompute. Each Dexie room write triggers a full recompute.

**Solution:** Cache the previous dexieRooms reference and skip recompute when unchanged.

**Files:**
- Modify: `src/entities/chat/model/chat-store.ts:587-634`
- Test: `src/entities/chat/model/chat-store-sorted.test.ts` (create)

**Step 1: Write the test**

```typescript
// src/entities/chat/model/chat-store-sorted.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { setActivePinia } from "pinia";
import { createTestingPinia } from "@pinia/testing";
import { useChatStore } from "./chat-store";
import { makeRoom } from "@/test-utils";

describe("sortedRooms", () => {
  let store: ReturnType<typeof useChatStore>;

  beforeEach(() => {
    setActivePinia(createTestingPinia({ stubActions: false }));
    store = useChatStore();
  });

  it("sorts pinned rooms first", () => {
    const r1 = makeRoom({ id: "!a:s", lastMessage: { id: "1", roomId: "!a:s", senderId: "u", content: "x", timestamp: 100, status: 2, type: 0 } as any });
    const r2 = makeRoom({ id: "!b:s", lastMessage: { id: "2", roomId: "!b:s", senderId: "u", content: "y", timestamp: 200, status: 2, type: 0 } as any });
    store.rooms = [r1, r2];
    store.togglePinRoom("!a:s");
    const sorted = store.sortedRooms;
    expect(sorted[0].id).toBe("!a:s"); // pinned, despite older timestamp
    expect(sorted[1].id).toBe("!b:s");
  });

  it("sorts joined rooms above invites regardless of timestamp", () => {
    const joined = makeRoom({ id: "!j:s", membership: "join", lastMessage: { id: "1", roomId: "!j:s", senderId: "u", content: "x", timestamp: 100, status: 2, type: 0 } as any });
    const invite = makeRoom({ id: "!i:s", membership: "invite", lastMessage: { id: "2", roomId: "!i:s", senderId: "u", content: "y", timestamp: 9999, status: 2, type: 0 } as any });
    store.rooms = [invite, joined];
    const sorted = store.sortedRooms;
    expect(sorted[0].id).toBe("!j:s");
    expect(sorted[1].id).toBe("!i:s");
  });

  it("sorts by timestamp within same tier", () => {
    const old = makeRoom({ id: "!old:s", lastMessage: { id: "1", roomId: "!old:s", senderId: "u", content: "x", timestamp: 100, status: 2, type: 0 } as any });
    const mid = makeRoom({ id: "!mid:s", lastMessage: { id: "2", roomId: "!mid:s", senderId: "u", content: "y", timestamp: 200, status: 2, type: 0 } as any });
    const fresh = makeRoom({ id: "!new:s", lastMessage: { id: "3", roomId: "!new:s", senderId: "u", content: "z", timestamp: 300, status: 2, type: 0 } as any });
    store.rooms = [old, fresh, mid];
    const sorted = store.sortedRooms;
    expect(sorted.map(r => r.id)).toEqual(["!new:s", "!mid:s", "!old:s"]);
  });

  it("returns rooms without lastMessage at the bottom", () => {
    const withMsg = makeRoom({ id: "!a:s", lastMessage: { id: "1", roomId: "!a:s", senderId: "u", content: "x", timestamp: 100, status: 2, type: 0 } as any });
    const noMsg = makeRoom({ id: "!b:s" });
    store.rooms = [noMsg, withMsg];
    const sorted = store.sortedRooms;
    expect(sorted[0].id).toBe("!a:s");
    expect(sorted[1].id).toBe("!b:s");
  });
});
```

**Step 2: Run test to verify it passes (baseline — tests existing behavior)**

Run: `npx vitest run src/entities/chat/model/chat-store-sorted.test.ts`
Expected: ALL PASS (tests verify current behavior before refactor)

**Step 3: Add structural sharing to sortedRooms**

Replace the `sortedRooms` computed in `chat-store.ts` (lines 587-634) with:

```typescript
  // Structural sharing: skip full recompute when dexieRooms reference hasn't changed
  let _prevDexieRef: import("@/shared/lib/local-db").LocalRoom[] | null = null;
  let _prevPinnedRef: ReadonlySet<string> | null = null;
  let _prevSorted: ChatRoom[] | null = null;

  const sortedRooms = computed(() => {
    // Use Dexie rooms when initialized (single source of truth), fallback to old shallowRef otherwise
    let source: ChatRoom[];
    const dexie = chatDbKitRef.value ? dexieRooms.value : null;

    if (dexie) {
      // Structural sharing: if dexieRooms reference AND pinnedRoomIds haven't changed, reuse previous result
      if (dexie === _prevDexieRef && pinnedRoomIds.value === _prevPinnedRef && _prevSorted) {
        return _prevSorted;
      }
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
      source = rooms.value;
    }

    const result = [...source]
      .sort((a, b) => {
        const aPinned = pinnedRoomIds.value.has(a.id) ? 1 : 0;
        const bPinned = pinnedRoomIds.value.has(b.id) ? 1 : 0;
        if (aPinned !== bPinned) return bPinned - aPinned;
        // Tier 1: joined rooms ALWAYS above invites
        const aInvite = a.membership === "invite" ? 1 : 0;
        const bInvite = b.membership === "invite" ? 1 : 0;
        if (aInvite !== bInvite) return aInvite - bInvite;
        // Tier 2: sort by last message time (within same membership tier)
        const aTime = a.lastMessage?.timestamp ?? 0;
        const bTime = b.lastMessage?.timestamp ?? 0;
        return bTime - aTime;
      });

    // Cache for structural sharing
    _prevDexieRef = dexie;
    _prevPinnedRef = pinnedRoomIds.value;
    _prevSorted = result;
    return result;
  });
```

**Step 4: Run all tests + type check**

Run: `npx vitest run && npx vue-tsc --noEmit`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add src/entities/chat/model/chat-store.ts src/entities/chat/model/chat-store-sorted.test.ts
git commit -m "perf: add structural sharing to sortedRooms computed

Skip full 2N-object recompute when dexieRooms reference unchanged.
Combined with bulkSyncRooms (single transaction), this reduces
sortedRooms recalculations from N-per-refresh to 1."
```

---

## Task 5: Single triggerRef in decryptRoomPreviews

**Problem:** `decryptRoomPreviews` (chat-store.ts:1368-1416) calls `triggerRef(rooms)` after each batch of 5 decryptions, causing up to 4 cascading recomputes of sortedRooms per cycle.

**Solution:** Collect all results, apply once, trigger once.

**Files:**
- Modify: `src/entities/chat/model/chat-store.ts:1341-1417`

**Step 1: Replace decryptRoomPreviews**

Replace `decryptRoomPreviews` function body (lines 1341-1417) with:

```typescript
  /** Decrypt last-message previews for rooms that show [encrypted].
   *  Results are stored in decryptedPreviewCache so they survive room list rebuilds.
   *  Single triggerRef at the end instead of per-batch — eliminates cascading recomputes.
   *  @param onlyRoomIds — if provided, only decrypt rooms in this set (incremental mode) */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const decryptRoomPreviews = async (matrixRooms: any[], onlyRoomIds?: Set<string>) => {
    // Collect rooms that need decryption
    const toDecrypt: Array<{ roomId: string; matrixRoom: unknown }> = [];
    for (const matrixRoom of matrixRooms) {
      const roomId = matrixRoom.roomId as string;
      if (onlyRoomIds && !onlyRoomIds.has(roomId)) continue;
      if (decryptedPreviewCache.has(roomId)) continue; // already decrypted
      const failInfo = decryptFailedRooms.get(roomId);
      if (failInfo) {
        if (failInfo.count >= DECRYPT_MAX_RETRIES) continue;
        if (Date.now() - failInfo.lastAttempt < DECRYPT_RETRY_DELAY) continue;
      }
      const room = getRoomById(roomId);
      const lmc = room?.lastMessage?.content;
      if (!lmc || lmc !== "[encrypted]") continue;
      toDecrypt.push({ roomId, matrixRoom });
    }
    if (toDecrypt.length === 0) return;

    // Cap at 20 rooms per cycle to avoid blocking
    const capped = toDecrypt.slice(0, 20);

    // Collect all decrypted results, apply once at the end
    const decryptedResults: Array<{ roomId: string; body: string }> = [];

    // Decrypt in small batches (5 at a time) but do NOT triggerRef per batch
    const BATCH = 5;
    for (let i = 0; i < capped.length; i += BATCH) {
      const batch = capped.slice(i, i + BATCH);

      await Promise.all(batch.map(async ({ roomId, matrixRoom }) => {
        try {
          const roomCrypto = await ensureRoomCrypto(roomId);
          if (!roomCrypto) return;

          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          let timelineEvents: unknown[] = [];
          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const lt = (matrixRoom as any).getLiveTimeline?.();
            if (lt) timelineEvents = lt.getEvents?.() ?? [];
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            if (!timelineEvents.length) timelineEvents = (matrixRoom as any).timeline ?? [];
          } catch { /* ignore */ }

          for (let j = timelineEvents.length - 1; j >= 0; j--) {
            const raw = getRawEvent(timelineEvents[j]);
            if (!raw?.content || raw.type !== "m.room.message") continue;
            const content = raw.content as Record<string, unknown>;
            if (content.msgtype !== "m.encrypted") continue;

            try {
              const decrypted = await roomCrypto.decryptEvent(raw);
              if (decrypted.body) {
                decryptedResults.push({ roomId, body: decrypted.body });
              }
            } catch {
              decryptFailedRooms.set(roomId, { count: (decryptFailedRooms.get(roomId)?.count ?? 0) + 1, lastAttempt: Date.now() });
            }
            break;
          }
        } catch {
          decryptFailedRooms.set(roomId, { count: (decryptFailedRooms.get(roomId)?.count ?? 0) + 1, lastAttempt: Date.now() });
        }
      }));
    }

    // Apply ALL decrypted results in one pass, then single triggerRef
    if (decryptedResults.length > 0) {
      for (const { roomId, body } of decryptedResults) {
        decryptedPreviewCache.set(roomId, body);
        const room = getRoomById(roomId);
        if (room?.lastMessage) {
          room.lastMessage = { ...room.lastMessage, content: body };
        }
      }
      triggerRef(rooms); // ONE triggerRef instead of up to 4
    }
  };
```

**Step 2: Run tests + type check**

Run: `npx vitest run && npx vue-tsc --noEmit`
Expected: ALL PASS

**Step 3: Commit**

```bash
git add src/entities/chat/model/chat-store.ts
git commit -m "perf: single triggerRef in decryptRoomPreviews

Collect all decrypted results and apply in one pass instead of
triggering reactivity after each batch of 5. Reduces cascading
sortedRooms recomputes from 4 to 1 per decrypt cycle."
```

---

## Task 6: Readiness Guard in Event Handlers

**Problem:** `onTimeline` handler in `stores.ts:284-288` calls `handleTimelineEvent()` even before initial sync completes. Events processed before `roomsInitialized` is true cause Dexie writes → liveQuery fires → sortedRooms recomputes against incomplete room list.

**Solution:** Skip handleTimelineEvent before roomsInitialized, but keep markRoomChanged so the first fullRoomRefresh processes all rooms.

**Files:**
- Modify: `src/entities/auth/model/stores.ts:284-288`

**Step 1: Add readiness guard**

Replace the `onTimeline` handler (lines 284-288) with:

```typescript
        onTimeline: (event: unknown, room: unknown) => {
          const roomId = typeof room === "string" ? room : (room as any)?.roomId;
          if (roomId) chatStore.markRoomChanged(roomId);
          // Skip event processing before initial sync completes — events will be
          // picked up by fullRoomRefresh reconciliation. Processing them early causes
          // Dexie writes → liveQuery notifications against an incomplete room list.
          if (roomId && chatStore.roomsInitialized) {
            chatStore.handleTimelineEvent(event, roomId);
          }
        },
```

**Step 2: Run tests + type check**

Run: `npx vitest run && npx vue-tsc --noEmit`
Expected: ALL PASS

**Step 3: Commit**

```bash
git add src/entities/auth/model/stores.ts
git commit -m "perf: skip timeline event processing before initial sync

Guard handleTimelineEvent with roomsInitialized check. Events during
initial sync are tracked via markRoomChanged and reconciled by
fullRoomRefresh. Prevents premature Dexie writes and liveQuery noise."
```

---

## Task 7: Add Instrumentation to Critical Paths

**Files:**
- Modify: `src/entities/chat/model/chat-store.ts` (3 insertion points)

**Step 1: Instrument fullRoomRefresh**

At the START of `fullRoomRefresh` function (after the opening `{`, around line 730), add:

```typescript
    perfMark("fullRoomRefresh-start");
```

At the END of `fullRoomRefresh` (before the closing `};` of the function, before the comment about display names around line 845), add:

```typescript
    perfMark("fullRoomRefresh-end");
    perfMeasure("fullRoomRefresh", "fullRoomRefresh-start", "fullRoomRefresh-end");
```

Add import at top of file (line 12, after the triggerRef import):

```typescript
import { perfMark, perfMeasure, perfCount } from "@/shared/lib/perf-markers";
```

**Step 2: Instrument sortedRooms recompute counter**

At the very start of the `sortedRooms` computed (first line inside the function body), add:

```typescript
    perfCount("sortedRooms:recompute");
```

**Step 3: Instrument setActiveRoom**

At the start of `setActiveRoom`, add `perfMark("setActiveRoom-start")`.
Where the function returns or at the end of its sync body, add the measure.

**Step 4: Run tests + build**

Run: `npx vitest run && npm run build`
Expected: ALL PASS, build succeeds

**Step 5: Commit**

```bash
git add src/entities/chat/model/chat-store.ts
git commit -m "perf: add performance instrumentation to critical store paths

Marks fullRoomRefresh duration, sortedRooms recompute count, and
setActiveRoom timing. Zero overhead when not observed."
```

---

## Task 8: Verification

**Step 1: Run full test suite**

Run: `npx vitest run`
Expected: ALL PASS

**Step 2: Type check**

Run: `npx vue-tsc --noEmit`
Expected: No errors

**Step 3: Build**

Run: `npm run build`
Expected: Build succeeds

**Step 4: Lint**

Run: `npm run lint`
Expected: No errors (or only pre-existing ones)

---

## Summary of Changes

| Change | File | Impact | Risk |
|--------|------|--------|------|
| Perf markers module | `perf-markers.ts` | Instrumentation only | Zero |
| `bulkSyncRooms` | `room-repository.ts` | N→1 liveQuery notifications | Low — same data, one transaction |
| Wire bulkSyncRooms | `chat-store.ts` | Eliminates N individual Dexie writes | Low — preserves monotonic guards |
| sortedRooms structural sharing | `chat-store.ts` | Skip 2N allocs when unchanged | Low — same sort logic |
| Single triggerRef | `chat-store.ts` | 4→1 cascading recomputes per decrypt | Minimal — same visual result |
| Readiness guard | `stores.ts` | No premature Dexie writes | Low — fullRoomRefresh catches up |
| Instrumentation | `chat-store.ts` | Observable metrics | Zero |

**Expected combined effect:** For an account with 200 rooms, a single sync event currently triggers ~200 Dexie writes → ~200 liveQuery notifications → ~200 sortedRooms recomputes (each allocating 400 objects). After these changes: 1 transaction → 1 notification → 1 recompute → 1 set of allocations (or 0 if reference unchanged).
