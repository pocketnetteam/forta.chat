import { describe, it, expect } from "vitest";
import { cleanupStaleRooms, type CleanupContext, ORPHAN_SYNC_SAFETY_MS } from "../room-cleanup";
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
    syncedAt: overrides.syncedAt ?? Date.now(),
    hasMoreHistory: true,
    isDeleted: overrides.isDeleted ?? false,
    deletedAt: overrides.deletedAt ?? null,
    deleteReason: overrides.deleteReason ?? null,
    ...overrides,
  };
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

describe("cleanupStaleRooms — data-loss guard (WEE-61 / forta-bugs#892)", () => {
  it("does NOT delete a freshly-synced room even when isRoomInSdk=false", async () => {
    // The SDK has not materialized this room into memory yet (slow cold-start
    // after update), but it was synced 5s ago — it is valid, not orphaned.
    const rooms = [makeLocalRoom({ id: "!fresh:s", syncedAt: Date.now() - 5_000 })];
    const ctx = makeContext(rooms, new Set()); // empty SDK

    const count = await cleanupStaleRooms(ctx);

    expect(count).toBe(0);
    expect(ctx._deletedIds).toEqual([]);
  });

  it("deletes a genuinely orphaned room not synced for longer than the safety window", async () => {
    const rooms = [
      makeLocalRoom({ id: "!orphan:s", syncedAt: Date.now() - ORPHAN_SYNC_SAFETY_MS - 60_000 }),
    ];
    const ctx = makeContext(rooms, new Set());

    const count = await cleanupStaleRooms(ctx);

    expect(count).toBe(1);
    expect(ctx._deletedIds).toEqual(["!orphan:s"]);
  });

  it("treats a room exactly at the safety boundary as still fresh (keeps it)", async () => {
    const rooms = [
      makeLocalRoom({ id: "!boundary:s", syncedAt: Date.now() - ORPHAN_SYNC_SAFETY_MS + 1_000 }),
    ];
    const ctx = makeContext(rooms, new Set());

    const count = await cleanupStaleRooms(ctx);

    expect(count).toBe(0);
    expect(ctx._deletedIds).toEqual([]);
  });

  it("still removes membership=leave rooms regardless of fresh syncedAt", async () => {
    // The leave branch is authoritative (server told us we left) — unaffected by the guard.
    const rooms = [makeLocalRoom({ id: "!left:s", membership: "leave", syncedAt: Date.now() })];
    const ctx = makeContext(rooms, new Set());

    const count = await cleanupStaleRooms(ctx);

    expect(count).toBe(1);
    expect(ctx._deletedIds).toEqual(["!left:s"]);
  });

  it("protects 50+ freshly-synced rooms on a slow cold-start (the #892 scenario)", async () => {
    const rooms = Array.from({ length: 60 }, (_, i) =>
      makeLocalRoom({ id: `!room${i}:s`, syncedAt: Date.now() - 10_000 }),
    );
    const ctx = makeContext(rooms, new Set()); // SDK loaded none yet

    const count = await cleanupStaleRooms(ctx);

    expect(count).toBe(0);
    expect(ctx._deletedIds).toEqual([]);
  });
});
