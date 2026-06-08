import { describe, it, expect } from "vitest";
import {
  cleanupStaleRooms,
  classifyOpenedRoomHealth,
  type CleanupContext,
  ACTIVE_ROOM_SAFETY_MS,
} from "../room-cleanup";
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

function makeContext(
  rooms: LocalRoom[],
  sdkRoomIds: Set<string> = new Set(rooms.map((r) => r.id)),
  historyVisibility: Record<string, string> = {},
): CleanupContext & { _deletedIds: string[] } {
  const deletedIds: string[] = [];
  return {
    getAllRooms: () => Promise.resolve(rooms),
    deleteRooms: async (ids) => {
      deletedIds.push(...ids);
    },
    isRoomInSdk: (id) => sdkRoomIds.has(id),
    getRoomHistoryVisibility: (id) => historyVisibility[id] ?? null,
    _deletedIds: deletedIds,
  } as CleanupContext & { _deletedIds: string[] };
}

// ---------------------------------------------------------------------------
// WEE-84: active room survives re-entry (cleanup branch-1 activity guard)
// ---------------------------------------------------------------------------

describe("cleanupStaleRooms — active room survives re-entry (WEE-84)", () => {
  it("does NOT tombstone a leave room with a recent message (just opened → wrote)", async () => {
    const rooms = [
      makeLocalRoom({
        id: "!active-leave:s",
        membership: "leave",
        lastMessageTimestamp: Date.now() - 5_000, // wrote 5s ago
      }),
    ];
    const ctx = makeContext(rooms);

    const count = await cleanupStaleRooms(ctx);

    expect(count).toBe(0);
    expect(ctx._deletedIds).toEqual([]);
  });

  it("still tombstones a leave room with no recent activity (WEE-61 regression intact)", async () => {
    const rooms = [
      makeLocalRoom({
        id: "!stale-leave:s",
        membership: "leave",
        lastMessageTimestamp: Date.now() - ACTIVE_ROOM_SAFETY_MS - 60_000,
      }),
    ];
    const ctx = makeContext(rooms);

    const count = await cleanupStaleRooms(ctx);

    expect(count).toBe(1);
    expect(ctx._deletedIds).toEqual(["!stale-leave:s"]);
  });

  it("still tombstones a leave room that never had a message", async () => {
    // lastMessageTimestamp undefined → treated as inactive (genuine leave).
    const rooms = [makeLocalRoom({ id: "!empty-leave:s", membership: "leave" })];
    const ctx = makeContext(rooms);

    const count = await cleanupStaleRooms(ctx);

    expect(count).toBe(1);
    expect(ctx._deletedIds).toEqual(["!empty-leave:s"]);
  });

  it("keeps a leave room exactly inside the safety boundary", async () => {
    const rooms = [
      makeLocalRoom({
        id: "!boundary-leave:s",
        membership: "leave",
        lastMessageTimestamp: Date.now() - ACTIVE_ROOM_SAFETY_MS + 1_000,
      }),
    ];
    const ctx = makeContext(rooms);

    const count = await cleanupStaleRooms(ctx);

    expect(count).toBe(0);
    expect(ctx._deletedIds).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// WEE-84: on-open zombie classification — undefined membership / missing SDK
// room are NOT zombies (the dominant `selfHealZombieRoom` trigger).
// ---------------------------------------------------------------------------

describe("classifyOpenedRoomHealth (WEE-84)", () => {
  it("keeps a room not yet materialized in the SDK (slow sync / channel outside SDK)", () => {
    expect(classifyOpenedRoomHealth(false, undefined)).toEqual({ action: "keep" });
    expect(classifyOpenedRoomHealth(false, "join")).toEqual({ action: "keep" });
  });

  it("keeps a room whose membership has not materialized yet (undefined/null)", () => {
    expect(classifyOpenedRoomHealth(true, undefined)).toEqual({ action: "keep" });
    expect(classifyOpenedRoomHealth(true, null)).toEqual({ action: "keep" });
  });

  it("keeps joined and invited rooms", () => {
    expect(classifyOpenedRoomHealth(true, "join")).toEqual({ action: "keep" });
    expect(classifyOpenedRoomHealth(true, "invite")).toEqual({ action: "keep" });
  });

  it("tombstones only on an EXPLICIT leave/ban", () => {
    expect(classifyOpenedRoomHealth(true, "leave")).toEqual({
      action: "tombstone",
      reason: "left",
    });
    expect(classifyOpenedRoomHealth(true, "ban")).toEqual({
      action: "tombstone",
      reason: "banned",
    });
  });

  it("does not treat an unknown membership string as a zombie", () => {
    // Defensive: any non-leave/ban value (e.g. a future state) is kept, never
    // defaulted to a tombstone.
    expect(classifyOpenedRoomHealth(true, "knock")).toEqual({ action: "keep" });
  });
});
