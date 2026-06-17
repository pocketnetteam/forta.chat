import { describe, it, expect } from "vitest";
import { cleanupStaleRooms, type CleanupContext, ORPHAN_SYNC_SAFETY_MS } from "../room-cleanup";
import type { LocalRoom } from "@/shared/lib/local-db";

/**
 * WEE-65 (H1) — ⚠️ DATA LOSS on a NEW / reinstalled device.
 *
 * On a fresh install every room lands in Dexie with `syncedAt = undefined`
 * *before* the first sync materializes it into the Matrix SDK. The previous
 * guard collapsed that to epoch 0 (`syncedAt ?? 0`), so `now - 0` always
 * exceeded the safety window and valid never-synced rooms (= contacts) were
 * tombstoned before the first sync could claim them. These tests pin the fix:
 * a never-synced room is kept unconditionally, while the WEE-61 behaviour
 * (already-synced orphans still GC'd) is preserved.
 */

function makeLocalRoom(overrides: Partial<LocalRoom> = {}): LocalRoom {
  const base: LocalRoom = {
    id: "!r:s",
    name: "Room",
    isGroup: false,
    members: [],
    membership: "join",
    unreadCount: 0,
    lastReadInboundTs: 0,
    lastReadOutboundTs: 0,
    updatedAt: Date.now(),
    lastMessageTimestamp: undefined,
    syncedAt: Date.now(),
    hasMoreHistory: true,
    isDeleted: false,
    deletedAt: null,
    deleteReason: null,
  };
  // Spread last so an explicit `syncedAt: undefined` override survives (it must,
  // to model a never-synced room).
  return { ...base, ...overrides };
}

function makeContext(rooms: LocalRoom[], sdkRoomIds: Set<string>): CleanupContext & { _deletedIds: string[] } {
  const deletedIds: string[] = [];
  return {
    getAllRooms: () => Promise.resolve(rooms),
    deleteRooms: async (ids) => {
      deletedIds.push(...ids);
    },
    isRoomInSdk: (id) => sdkRoomIds.has(id),
    getRoomHistoryVisibility: () => null,
    _deletedIds: deletedIds,
  } as CleanupContext & { _deletedIds: string[] };
}

describe("cleanupStaleRooms — new-device data-loss guard (WEE-65 H1)", () => {
  it("does NOT tombstone a never-synced room (syncedAt undefined) absent from the SDK", async () => {
    // New device: room exists in Dexie, sync hasn't materialized it into the SDK
    // yet, and it has never been synced. It must survive.
    const rooms = [makeLocalRoom({ id: "!new:s", syncedAt: undefined })];
    const ctx = makeContext(rooms, new Set()); // empty SDK

    const count = await cleanupStaleRooms(ctx);

    expect(count).toBe(0);
    expect(ctx._deletedIds).toEqual([]);
  });

  it("treats syncedAt=0 (legacy/unset) the same as never-synced — keeps it", async () => {
    const rooms = [makeLocalRoom({ id: "!zero:s", syncedAt: 0 })];
    const ctx = makeContext(rooms, new Set());

    const count = await cleanupStaleRooms(ctx);

    expect(count).toBe(0);
    expect(ctx._deletedIds).toEqual([]);
  });

  it("protects 50+ never-synced rooms on a fresh login over a slow network (#907/#455)", async () => {
    const rooms = Array.from({ length: 60 }, (_, i) =>
      makeLocalRoom({ id: `!room${i}:s`, syncedAt: undefined }),
    );
    const ctx = makeContext(rooms, new Set()); // SDK loaded none yet

    const count = await cleanupStaleRooms(ctx);

    expect(count).toBe(0);
    expect(ctx._deletedIds).toEqual([]);
  });

  it("keeps never-synced rooms of ALL types — groups too (#972)", async () => {
    const rooms = [
      makeLocalRoom({ id: "!dm:s", isGroup: false, syncedAt: undefined }),
      makeLocalRoom({ id: "!group:s", isGroup: true, syncedAt: undefined }),
    ];
    const ctx = makeContext(rooms, new Set());

    const count = await cleanupStaleRooms(ctx);

    expect(count).toBe(0);
    expect(ctx._deletedIds).toEqual([]);
  });

  it("WEE-61 regression preserved: an already-synced orphan past the window is STILL removed", async () => {
    const rooms = [
      makeLocalRoom({ id: "!stale:s", syncedAt: Date.now() - ORPHAN_SYNC_SAFETY_MS - 60_000 }),
    ];
    const ctx = makeContext(rooms, new Set());

    const count = await cleanupStaleRooms(ctx);

    expect(count).toBe(1);
    expect(ctx._deletedIds).toEqual(["!stale:s"]);
  });

  it("WEE-61 regression preserved: a freshly-synced room (within window) is kept", async () => {
    const rooms = [makeLocalRoom({ id: "!fresh:s", syncedAt: Date.now() - 5_000 })];
    const ctx = makeContext(rooms, new Set());

    const count = await cleanupStaleRooms(ctx);

    expect(count).toBe(0);
    expect(ctx._deletedIds).toEqual([]);
  });

  it("a never-synced room present in the SDK falls through to other checks (no false delete)", async () => {
    // In SDK + not leave + not world_readable → kept.
    const rooms = [makeLocalRoom({ id: "!insdk:s", syncedAt: undefined })];
    const ctx = makeContext(rooms, new Set(["!insdk:s"]));

    const count = await cleanupStaleRooms(ctx);

    expect(count).toBe(0);
    expect(ctx._deletedIds).toEqual([]);
  });
});
