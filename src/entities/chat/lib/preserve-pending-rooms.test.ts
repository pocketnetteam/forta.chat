import { describe, it, expect } from "vitest";
import { preservePendingRooms, PENDING_GRACE_MS } from "./preserve-pending-rooms";
import type { ChatRoom } from "../model/types";

function makeRoom(overrides: Partial<ChatRoom> = {}): ChatRoom {
  return {
    id: "!room:server",
    name: "Room",
    unreadCount: 0,
    members: ["a"],
    isGroup: true,
    updatedAt: Date.now(),
    ...overrides,
  };
}

describe("preservePendingRooms", () => {
  const NOW = 1_000_000_000_000;

  it("preserves a recently-added room missing from the new SDK snapshot", () => {
    const fresh = makeRoom({ id: "!fresh:s", updatedAt: NOW - 1000 });
    const old = makeRoom({ id: "!old:s", updatedAt: NOW - 60_000 });
    const existing = [fresh, old];
    const incoming = [makeRoom({ id: "!old:s", updatedAt: NOW - 60_000 })];
    const incomingIds = new Set(incoming.map(r => r.id));

    const preserved = preservePendingRooms({
      existingRooms: existing,
      incomingRoomIds: incomingIds,
      nowMs: NOW,
    });

    expect(preserved.map(r => r.id)).toEqual(["!fresh:s"]);
  });

  it("drops rooms older than the grace window", () => {
    const stale = makeRoom({
      id: "!stale:s",
      updatedAt: NOW - PENDING_GRACE_MS - 1000,
    });
    const incomingIds = new Set<string>();

    const preserved = preservePendingRooms({
      existingRooms: [stale],
      incomingRoomIds: incomingIds,
      nowMs: NOW,
    });

    expect(preserved).toEqual([]);
  });

  it("does not preserve rooms already present in the SDK snapshot", () => {
    const recent = makeRoom({ id: "!recent:s", updatedAt: NOW - 100 });
    const incomingIds = new Set(["!recent:s"]);

    const preserved = preservePendingRooms({
      existingRooms: [recent],
      incomingRoomIds: incomingIds,
      nowMs: NOW,
    });

    expect(preserved).toEqual([]);
  });

  it("treats missing updatedAt as ancient (drops it)", () => {
    const noTs = makeRoom({ id: "!nots:s" });
    // Force missing field to verify the ?? 0 fallback drops it.
    delete (noTs as unknown as Record<string, unknown>).updatedAt;
    const incomingIds = new Set<string>();

    const preserved = preservePendingRooms({
      existingRooms: [noTs],
      incomingRoomIds: incomingIds,
      nowMs: NOW,
    });

    expect(preserved).toEqual([]);
  });

  it("returns rooms in the order they appear in existingRooms", () => {
    const a = makeRoom({ id: "!a:s", updatedAt: NOW - 500 });
    const b = makeRoom({ id: "!b:s", updatedAt: NOW - 100 });
    const c = makeRoom({ id: "!c:s", updatedAt: NOW - 200 });

    const preserved = preservePendingRooms({
      existingRooms: [a, b, c],
      incomingRoomIds: new Set<string>(),
      nowMs: NOW,
    });

    expect(preserved.map(r => r.id)).toEqual(["!a:s", "!b:s", "!c:s"]);
  });

  it("PENDING_GRACE_MS is 30 seconds", () => {
    // Pin the constant — Matrix /sync typically delivers within 1-30s; this
    // window covers the worst case while still dropping genuinely-failed
    // creates so they don't linger in the sidebar forever.
    expect(PENDING_GRACE_MS).toBe(30_000);
  });
});
