import { describe, it, expect, vi } from "vitest";
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

function makeContext(
  rooms: LocalRoom[],
  sdkRoomIds: Set<string> = new Set(rooms.map((r) => r.id)),
  historyVisibility: Record<string, string> = {},
): CleanupContext {
  const deletedIds: string[] = [];
  return {
    getAllRooms: () => Promise.resolve(rooms),
    deleteRooms: async (ids) => {
      deletedIds.push(...ids);
    },
    isRoomInSdk: (id) => sdkRoomIds.has(id),
    getRoomHistoryVisibility: (id) => historyVisibility[id] ?? null,
    /** Test helper — not part of CleanupContext */
    _deletedIds: deletedIds,
  } as CleanupContext & { _deletedIds: string[] };
}

const FOUR_DAYS_AGO = Date.now() - 4 * 24 * 60 * 60 * 1000;
const ONE_HOUR_AGO = Date.now() - 60 * 60 * 1000;

describe("cleanupStaleRooms", () => {
  it("removes rooms with membership=leave", async () => {
    const rooms = [makeLocalRoom({ id: "!left:s", membership: "leave" })];
    const ctx = makeContext(rooms) as CleanupContext & { _deletedIds: string[] };

    const count = await cleanupStaleRooms(ctx);

    expect(count).toBe(1);
    expect(ctx._deletedIds).toEqual(["!left:s"]);
  });

  it("removes orphaned rooms not in SDK", async () => {
    const rooms = [makeLocalRoom({ id: "!orphan:s" })];
    const sdkRoomIds = new Set<string>(); // empty — room not in SDK
    const ctx = makeContext(rooms, sdkRoomIds) as CleanupContext & { _deletedIds: string[] };

    const count = await cleanupStaleRooms(ctx);

    expect(count).toBe(1);
    expect(ctx._deletedIds).toEqual(["!orphan:s"]);
  });

  it("removes stream rooms (world_readable) inactive >3 days", async () => {
    const rooms = [
      makeLocalRoom({ id: "!stream:s", lastMessageTimestamp: FOUR_DAYS_AGO }),
    ];
    const ctx = makeContext(rooms, new Set(["!stream:s"]), {
      "!stream:s": "world_readable",
    }) as CleanupContext & { _deletedIds: string[] };

    const count = await cleanupStaleRooms(ctx);

    expect(count).toBe(1);
    expect(ctx._deletedIds).toEqual(["!stream:s"]);
  });

  it("keeps active stream rooms", async () => {
    const rooms = [
      makeLocalRoom({ id: "!active-stream:s", lastMessageTimestamp: ONE_HOUR_AGO }),
    ];
    const ctx = makeContext(rooms, new Set(["!active-stream:s"]), {
      "!active-stream:s": "world_readable",
    }) as CleanupContext & { _deletedIds: string[] };

    const count = await cleanupStaleRooms(ctx);

    expect(count).toBe(0);
    expect(ctx._deletedIds).toEqual([]);
  });

  it("uses stored isWorldReadable flag instead of SDK lookup", async () => {
    const rooms = [
      makeLocalRoom({
        id: "!wr:s",
        lastMessageTimestamp: FOUR_DAYS_AGO,
        isWorldReadable: true,
      }),
    ];
    // No historyVisibility in SDK — should still detect via stored field
    const ctx = makeContext(rooms, new Set(["!wr:s"]), {}) as CleanupContext & { _deletedIds: string[] };

    const count = await cleanupStaleRooms(ctx);

    expect(count).toBe(1);
    expect(ctx._deletedIds).toEqual(["!wr:s"]);
  });

  it("keeps normal joined rooms", async () => {
    const rooms = [
      makeLocalRoom({ id: "!normal:s", membership: "join" }),
    ];
    const ctx = makeContext(rooms) as CleanupContext & { _deletedIds: string[] };

    const count = await cleanupStaleRooms(ctx);

    expect(count).toBe(0);
    expect(ctx._deletedIds).toEqual([]);
  });

  it("handles mixed rooms correctly", async () => {
    const rooms = [
      makeLocalRoom({ id: "!keep:s", membership: "join" }),
      makeLocalRoom({ id: "!left:s", membership: "leave" }),
      makeLocalRoom({ id: "!orphan:s", membership: "join" }),
      makeLocalRoom({ id: "!stale-stream:s", membership: "join", lastMessageTimestamp: FOUR_DAYS_AGO }),
      makeLocalRoom({ id: "!fresh-stream:s", membership: "join", lastMessageTimestamp: ONE_HOUR_AGO }),
    ];
    const sdkRoomIds = new Set(["!keep:s", "!left:s", "!stale-stream:s", "!fresh-stream:s"]);
    const histVis = {
      "!stale-stream:s": "world_readable",
      "!fresh-stream:s": "world_readable",
    };
    const ctx = makeContext(rooms, sdkRoomIds, histVis) as CleanupContext & { _deletedIds: string[] };

    const count = await cleanupStaleRooms(ctx);

    expect(count).toBe(3); // left + orphan + stale-stream
    expect(ctx._deletedIds).toContain("!left:s");
    expect(ctx._deletedIds).toContain("!orphan:s");
    expect(ctx._deletedIds).toContain("!stale-stream:s");
    expect(ctx._deletedIds).not.toContain("!keep:s");
    expect(ctx._deletedIds).not.toContain("!fresh-stream:s");
  });
});
