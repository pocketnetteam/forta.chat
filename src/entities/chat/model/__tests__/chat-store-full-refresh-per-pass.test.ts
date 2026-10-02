// @vitest-environment happy-dom
/**
 * fullRoomRefresh took ~70s on a 5000-room account. Per-room work that is the
 * same for the whole pass is now done once per pass:
 *  - each room's members are read once and handed to the build,
 *    updateDisplayNames and loadMissingMembers (was 3-4 reads per room);
 *  - the call push-rule dates (push-rule scan + localStorage) are read once,
 *    not per room;
 *  - member display names are published in one assignment instead of one
 *    reactive write per member.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { watchSyncEffect } from "vue";
import { setActivePinia } from "pinia";
import { createTestingPinia } from "@pinia/testing";
import { hexEncode } from "@/shared/lib/matrix/functions";

const ROOM_COUNT = 6;
const peers = Array.from({ length: ROOM_COUNT }, (_, i) => `Peer${i}addr`);

const mxRooms = peers.map((peer, i) => ({
  roomId: `!r${i}:s`,
  name: `Room ${i}`,
  selfMembership: "join",
  currentState: { getStateEvents: () => [] },
  getLiveTimeline: () => ({ getEvents: () => [] }),
  getUnreadNotificationCount: () => 0,
  peer,
}));

const membersOf = (room: { peer: string }) => [
  { userId: `@${hexEncode("Meaddr")}:s`, membership: "join", rawDisplayName: "Me" },
  { userId: `@${hexEncode(room.peer)}:s`, membership: "join", rawDisplayName: `Name of ${room.peer}` },
];

const getRoomMembers = vi.fn((room: { peer: string }) => membersOf(room));
const kit = {
  client: { getUserId: () => "@me:s" },
  isTetatetChat: vi.fn(() => true),
  getRoomMembers,
};

const mockMatrixService = {
  getUserId: vi.fn(() => `@${hexEncode("Meaddr")}:s`),
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

const callHangupRuleSince = vi.fn(() => null);
vi.mock("@/shared/lib/push/call-hangup-push-rule", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/shared/lib/push/call-hangup-push-rule")>()),
  callHangupRuleSince: () => callHangupRuleSince(),
}));

import { useChatStore } from "../chat-store";

describe("fullRoomRefresh — per-pass work done once", () => {
  let store: ReturnType<typeof useChatStore>;

  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    setActivePinia(createTestingPinia({ stubActions: false }));
    store = useChatStore();
    getRoomMembers.mockClear();
    callHangupRuleSince.mockClear();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    store.setHelpers(kit as any, { rooms: {} } as any);
  });

  const runFullRefresh = async () => {
    store.refreshRoomsNow();
    await vi.waitFor(() => expect(store.rooms).toHaveLength(ROOM_COUNT));
    // updateDisplayNames runs after the build
    await vi.waitFor(() => expect(store.getDisplayName(peers[0])).toBe(`Name of ${peers[0]}`));
  };

  it("reads each room's members once for the build and the display names", async () => {
    await runFullRefresh();
    // loadMissingMembers only re-reads rooms it actually loaded (none here)
    expect(getRoomMembers).toHaveBeenCalledTimes(ROOM_COUNT);
  });

  it("reads the call push-rule dates once per pass, not per room", async () => {
    await runFullRefresh();
    expect(callHangupRuleSince).toHaveBeenCalledTimes(1);
  });

  it("publishes the member display names in one update", async () => {
    let runs = 0;
    watchSyncEffect(() => {
      for (const p of peers) store.getDisplayName(p);
      runs++;
    });
    const before = runs;
    await runFullRefresh();
    for (const p of peers) expect(store.getDisplayName(p)).toBe(`Name of ${p}`);
    expect(runs - before).toBe(1);
  });
});
