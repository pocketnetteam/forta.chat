// @vitest-environment happy-dom
/**
 * Lazy-loaded members, background fill (plan 2026-10-03, stage 4). After the
 * first full refresh the members of every 1:1 room whose peer the SDK has
 * not delivered are loaded in the background — not only the first viewport —
 * since names, search, the ignored-user filter and typing need the peer.
 * Invites are never asked (/members needs a joined room), and with lazy
 * loading off nothing is requested at all.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { setActivePinia } from "pinia";
import { createTestingPinia } from "@pinia/testing";
import { hexEncode } from "@/shared/lib/matrix/functions";

const ME = `@${hexEncode("Meaddr")}:s`;
/** More than the 15-room first viewport, so some rooms are left to the fill. */
const ROOM_COUNT = 20;

let lazyLoading = true;
const makeMxRoom = (i: number, membership = "join") => {
  let loaded = false;
  const members = [{ userId: ME, membership: "join", rawDisplayName: "Me" }];
  const room = {
    roomId: `!r${i}:s`,
    name: `#${"a".repeat(56)}`,
    selfMembership: membership,
    getMyMembership: () => membership,
    currentState: { getStateEvents: () => [] },
    getLiveTimeline: () => ({ getEvents: () => [] }),
    getUnreadNotificationCount: () => 0,
    getJoinedMemberCount: () => 2,
    membersLoaded: () => !lazyLoading || loaded,
    loadMembersIfNeeded: vi.fn(async () => {
      members.push({ userId: `@${hexEncode(`Peer${i}`)}:s`, membership: "join", rawDisplayName: `Peer ${i}` });
      loaded = true;
      return true;
    }),
    members,
  };
  return room;
};

let mxRooms: ReturnType<typeof makeMxRoom>[] = [];
const kit = {
  client: { getUserId: () => ME },
  isTetatetChat: vi.fn(() => true),
  getRoomMembers: vi.fn((room: { members: unknown[] }) => [...room.members]),
};
const mockMatrixService = {
  getUserId: vi.fn(() => ME),
  getRoom: vi.fn((id: string) => mxRooms.find((r) => r.roomId === id)),
  getRooms: vi.fn(() => mxRooms),
  isReady: vi.fn(() => true),
  getRoomAccountData: vi.fn(() => null),
  getIgnoredMatrixUserIds: vi.fn(() => [] as string[]),
  matrixId: vi.fn((id: string) => id),
  isMe: vi.fn(() => false),
  client: { pushRules: undefined },
};
vi.mock("@/entities/matrix", () => ({
  getMatrixClientService: vi.fn(() => mockMatrixService),
}));

import { useChatStore } from "../chat-store";

describe("fullRoomRefresh — background fill of 1:1 members", () => {
  let store: ReturnType<typeof useChatStore>;

  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    setActivePinia(createTestingPinia({ stubActions: false }));
    store = useChatStore();
    lazyLoading = true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    store.setHelpers(kit as any, { rooms: {} } as any);
  });

  const runFullRefresh = async () => {
    store.refreshRoomsNow();
    await vi.waitFor(() => expect(store.rooms.length).toBeGreaterThan(0));
  };

  it("loads the members of every joined 1:1 room, beyond the first viewport too", async () => {
    mxRooms = Array.from({ length: ROOM_COUNT }, (_, i) => makeMxRoom(i));
    await runFullRefresh();

    await vi.waitFor(() => {
      for (const r of mxRooms) expect(r.loadMembersIfNeeded).toHaveBeenCalledTimes(1);
    });
    // The loaded peer reaches the stored room.
    await vi.waitFor(() => expect(store.rooms.find((r) => r.id === "!r19:s")?.members).toContain(hexEncode("Peer19")));
  });

  it("never asks /members for invites", async () => {
    mxRooms = [...Array.from({ length: ROOM_COUNT }, (_, i) => makeMxRoom(i)), makeMxRoom(99, "invite")];
    await runFullRefresh();

    await vi.waitFor(() => expect(mxRooms[ROOM_COUNT - 1].loadMembersIfNeeded).toHaveBeenCalled());
    expect(mxRooms[ROOM_COUNT].loadMembersIfNeeded).not.toHaveBeenCalled();
  });

  it("requests nothing when lazy loading is off", async () => {
    lazyLoading = false;
    mxRooms = Array.from({ length: ROOM_COUNT }, (_, i) => makeMxRoom(i));
    await runFullRefresh();
    await new Promise((r) => setTimeout(r, 50));

    for (const r of mxRooms) expect(r.loadMembersIfNeeded).not.toHaveBeenCalled();
  });
});
