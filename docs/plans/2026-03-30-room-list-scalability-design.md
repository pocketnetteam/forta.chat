# Room List Scalability Design (100k+ rooms)

**Date:** 2026-03-30
**Status:** Approved
**Problem:** On accounts with 100k+ chat rooms, new messages stop appearing in UI — push notifications arrive but messages don't render until app restart.

## Root Cause

`computeSortedRooms()` in `chat-store.ts:718-806` performs O(n log n) sort on ALL rooms whenever ANY room changes in Dexie. On 300k rooms this blocks the Event Loop for ~260ms, starving `Room.timeline` event handlers and causing push `waitForDecryptedEvent()` to timeout.

The chain: Dexie write → `useLiveQuery(getAllRooms())` returns full 300k table → watch triggers → `computeSortedRooms()` blocks thread → incoming message events queued → never processed.

### Why bastyon-chat doesn't have this problem

The old project (Vue 2 + Vuex) never sorts all rooms. Matrix SDK's internal `store.rooms` only exposes changed rooms. Vuex updates them with selective `Vue.set()`. Stream rooms are auto-deleted after 3 days, keeping the total count lower.

## Architecture: 4 Layers

```
┌─────────────────────────────────────────────────┐
│  Layer 1: Sync Filter (reduce inbound payload)   │
├─────────────────────────────────────────────────┤
│  Layer 2: Delta Tracking (know WHAT changed)     │
├─────────────────────────────────────────────────┤
│  Layer 3: Incremental Sort (O(k) list patching)  │
├─────────────────────────────────────────────────┤
│  Layer 4: Async Full Rebuild (fallback with yield)│
└─────────────────────────────────────────────────┘
```

## Layer 1: Sync Filter

**File:** `src/entities/matrix/model/matrix-client.ts`

Create a server-side filter via `createFilter()` before `startClient()` to eliminate unnecessary data from `/sync` responses:

```typescript
const syncFilter = {
  room: {
    timeline: { limit: 1, lazy_load_members: true },
    state: {
      lazy_load_members: true,
      types: ['m.room.name', 'm.room.avatar', 'm.room.canonical_alias', 'm.room.encryption'],
    },
    ephemeral: { types: [] },
    account_data: { types: ['m.fully_read', 'm.tag'] },
  },
  presence: { types: [] },
};
```

**Effect:** 5-10x smaller `/sync` payload on large accounts. Ephemeral events (typing indicators, read receipts) are excluded from sync — they'll be fetched on-demand when a room is opened.

## Layer 2: Delta Tracking via Dexie Hooks

**File:** `src/shared/lib/local-db/room-repository.ts`

Replace `useLiveQuery(getAllRooms())` (returns all 300k rows on any change) with Dexie table hooks that report exactly which rooms changed:

```typescript
type RoomChange =
  | { type: 'upsert'; room: LocalRoom }
  | { type: 'delete'; roomId: string };

observeRoomChanges(callback: (changes: RoomChange[]) => void): () => void
```

- Hooks (`creating`, `updating`, `deleting`) buffer changes via microtask
- Callback receives a batch of 1-50 changes instead of 300k full rows
- `getAllRooms()` remains for initial load only, but drops its `.sort()` (sort happens in chat-store)

## Layer 3: Incremental Sort

**File:** `src/entities/chat/model/chat-store.ts`

Replace `computeSortedRooms()` + dexieRooms watch with delta-based patching:

### Initial load (once):
```
getAllRooms() → map to ChatRoom[] → full sort → _sortedRoomsRef.value
Build positionIndex: Map<roomId, arrayIndex>
```

### Incremental updates (each sync):
```
RoomChange[] (1-5 rooms) → for each:
  1. mapLocalRoomToChatRoom() (with cache)
  2. Remove old position: positionIndex.get(roomId) → splice
  3. Binary search new position by timestamp
  4. splice insert
  5. Update positionIndex for shifted elements
→ _sortedRoomsRef.value = [...sorted] (new ref for Vue reactivity)
```

### Performance:
- `splice` removal + insertion = O(n) shift but native, <1ms for 300k
- Binary search = O(log n)
- Total: ~2-3ms for 5 changed rooms vs ~260ms for full re-sort

### Mass update guard:
When `changes.length > 100` (initial sync, fullRoomRefresh), switch to async full rebuild (Layer 4) instead of incremental patching.

## Layer 4: Async Full Rebuild

**File:** `src/entities/chat/model/chat-store.ts`

For initial sync and periodic reconciliation (every 5 minutes), full rebuild runs asynchronously:

1. Map LocalRoom → ChatRoom in chunks of 5000 with `yieldToMain()` between chunks
2. Sort chunks individually (sync, <5ms each), then async merge
3. Total time ~260ms but split into ~52 chunks of ~5ms — Event Loop stays free

This replaces the current synchronous `computeSortedRooms()` for all large-batch scenarios.

## Room Auto-Cleanup

**New file:** `src/entities/chat/model/room-cleanup.ts`

Ported from bastyon-chat — automatically reduce room count:

- Stream rooms (`world_readable`) with no activity for >3 days → leave + forget + delete from Dexie
- Rooms with `membership="leave"` in Dexie → delete from Dexie
- Rooms in Dexie but not in Matrix SDK → delete from Dexie (orphans)
- Schedule: on startup + every hour

## Files Changed

| File | Change |
|------|--------|
| `src/entities/matrix/model/matrix-client.ts` | Add sync filter before startClient |
| `src/shared/lib/local-db/room-repository.ts` | + `observeRoomChanges()`, remove sort from `getAllRooms()` |
| `src/entities/chat/model/chat-store.ts` | Replace dexieRooms liveQuery + computeSortedRooms with delta-based incremental sort + async full rebuild |
| `src/entities/chat/model/room-cleanup.ts` | **New** — auto-cleanup stale rooms |

## Expected Results

| Metric | Before (300k rooms) | After |
|--------|---------------------|-------|
| Sort per sync tick | ~260ms blocking | ~3ms incremental |
| Event Loop max block | 260ms+ | <5ms |
| Message delivery | Lost / timeout | Instant |
| Push → display | 15s timeout → fail | <200ms |
| Sync payload size | Full | 5-10x smaller |
| Room count growth | Unbounded | Auto-cleanup |
