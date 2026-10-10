import { describe, it, expect, vi, beforeEach } from "vitest";
import { MatrixClientService } from "../matrix-client";
import { ensureRoomMembers } from "../ensure-room-members";

/**
 * With lazy-loaded members a limited sync omits the membership changes of
 * users who did not post during the gap, so the room's cached member list
 * can be stale — a kicked member would keep receiving new keys. A reset of
 * the room's main timeline (the SDK's signal for a limited sync) marks the
 * list stale; the next encryption (ensureRoomMembers with `fresh`) reloads
 * it. It is not dropped at once: with a 4-event timeline limit resets are
 * routine, and names, calls and filters would lose the peer each time.
 */
describe("matrix-client Room.timelineReset — cached member list", () => {
  type Listener = (...args: unknown[]) => void;
  let listeners: Map<string, Listener>;

  beforeEach(() => {
    const service = new MatrixClientService("test.invalid");
    listeners = new Map();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (service as any).client = {
      credentials: { userId: "@me:test.invalid" },
      on: (event: string, fn: Listener) => { listeners.set(event, fn); },
    };
    service.setHandlers({ onTimelineReset: vi.fn() });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (service as any).initEvents();
  });

  let seq = 0;
  const makeRoom = () => {
    const mainSet = {};
    let loaded = true;
    return {
      roomId: `!r${++seq}:test.invalid`,
      getUnfilteredTimelineSet: () => mainSet,
      getLiveTimeline: () => ({ getPaginationToken: () => "t0" }),
      membersLoaded: () => loaded,
      loadMembersIfNeeded: vi.fn(async () => { loaded = true; return true; }),
      clearLoadedMembersIfNeeded: vi.fn(async () => { loaded = false; }),
      getMyMembership: () => "join",
      mainSet,
    };
  };

  it("keeps the cached members, and the next encryption reloads them", async () => {
    const room = makeRoom();
    listeners.get("Room.timelineReset")!(room, room.mainSet);
    expect(room.clearLoadedMembersIfNeeded).not.toHaveBeenCalled();

    await ensureRoomMembers(room, { fresh: true });

    expect(room.clearLoadedMembersIfNeeded).toHaveBeenCalledTimes(1);
    expect(room.loadMembersIfNeeded).toHaveBeenCalledTimes(1);
  });

  it("ignores resets of other timeline sets (threads, notifications)", async () => {
    const room = makeRoom();
    listeners.get("Room.timelineReset")!(room, {});

    await ensureRoomMembers(room, { fresh: true });

    expect(room.clearLoadedMembersIfNeeded).not.toHaveBeenCalled();
  });
});
