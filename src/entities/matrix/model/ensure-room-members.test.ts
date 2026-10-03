import { describe, it, expect, vi, afterEach } from "vitest";
import { ensureRoomMembers, markRoomMembersStale, ROOM_MEMBERS_TIMEOUT_MS } from "./ensure-room-members";

/** A room as the SDK builds it with lazy loading on and members not loaded yet. */
const lazyRoom = (over: Record<string, unknown> = {}) => ({
  roomId: "!r:s",
  membersLoaded: vi.fn(() => false),
  loadMembersIfNeeded: vi.fn(async () => true),
  getJoinedMemberCount: () => 2,
  getMyMembership: () => "join",
  ...over,
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ensureRoomMembers", () => {
  it("loads the members of a lazy-loaded room", async () => {
    const room = lazyRoom();
    await expect(ensureRoomMembers(room)).resolves.toBe(true);
    expect(room.loadMembersIfNeeded).toHaveBeenCalledTimes(1);
  });

  it("does nothing when the SDK has them all — lazyLoadMembers: false reports every room loaded", async () => {
    const room = lazyRoom({ membersLoaded: () => true });
    await expect(ensureRoomMembers(room)).resolves.toBe(false);
    expect(room.loadMembersIfNeeded).not.toHaveBeenCalled();
  });

  it("does nothing for a room object without membersLoaded (treated as loaded)", async () => {
    const room = lazyRoom({ membersLoaded: undefined });
    await expect(ensureRoomMembers(room)).resolves.toBe(false);
    expect(room.loadMembersIfNeeded).not.toHaveBeenCalled();
  });

  it("skips invites — /members needs a joined room", async () => {
    const room = lazyRoom({ getMyMembership: () => "invite" });
    await expect(ensureRoomMembers(room)).resolves.toBe(false);
    expect(room.loadMembersIfNeeded).not.toHaveBeenCalled();
  });

  it("skips rooms at or above maxJoined", async () => {
    const room = lazyRoom({ getJoinedMemberCount: () => 50 });
    await expect(ensureRoomMembers(room, { maxJoined: 50 })).resolves.toBe(false);
    expect(room.loadMembersIfNeeded).not.toHaveBeenCalled();
  });

  it("returns false for a missing room", async () => {
    await expect(ensureRoomMembers(null)).resolves.toBe(false);
  });

  it("propagates a failed load", async () => {
    const room = lazyRoom({ loadMembersIfNeeded: vi.fn(async () => { throw new Error("500"); }) });
    await expect(ensureRoomMembers(room)).rejects.toThrow("500");
  });

  it("honours a caller's shorter timeout", async () => {
    vi.useFakeTimers();
    const room = lazyRoom({ loadMembersIfNeeded: vi.fn(() => new Promise<boolean>(() => {})) });
    const pending = expect(ensureRoomMembers(room, { timeoutMs: 1_000 })).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(1_001);
    await pending;
  });

  it("times out instead of hanging a send", async () => {
    vi.useFakeTimers();
    const room = lazyRoom({ loadMembersIfNeeded: vi.fn(() => new Promise<boolean>(() => {})) });
    const pending = expect(ensureRoomMembers(room)).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(ROOM_MEMBERS_TIMEOUT_MS + 1);
    await pending;
  });
});

describe("stale member lists after a limited sync", () => {
  /** A room whose members were loaded once (lazy loading on). */
  const loadedRoom = (roomId: string) => {
    let loaded = true;
    return {
      roomId,
      membersLoaded: () => loaded,
      loadMembersIfNeeded: vi.fn(async () => { loaded = true; return true; }),
      clearLoadedMembersIfNeeded: vi.fn(async () => { loaded = false; }),
      getMyMembership: () => "join",
    };
  };

  it("a fresh caller reloads a list marked stale, once", async () => {
    const room = loadedRoom("!stale1:s");
    markRoomMembersStale(room.roomId);

    await expect(ensureRoomMembers(room, { fresh: true })).resolves.toBe(true);
    expect(room.clearLoadedMembersIfNeeded).toHaveBeenCalledTimes(1);
    expect(room.loadMembersIfNeeded).toHaveBeenCalledTimes(1);

    await expect(ensureRoomMembers(room, { fresh: true })).resolves.toBe(false);
    expect(room.loadMembersIfNeeded).toHaveBeenCalledTimes(1);
  });

  it("display callers keep the cached list (the peer stays for names and calls)", async () => {
    const room = loadedRoom("!stale2:s");
    markRoomMembersStale(room.roomId);

    await expect(ensureRoomMembers(room)).resolves.toBe(false);
    expect(room.clearLoadedMembersIfNeeded).not.toHaveBeenCalled();
  });
});
