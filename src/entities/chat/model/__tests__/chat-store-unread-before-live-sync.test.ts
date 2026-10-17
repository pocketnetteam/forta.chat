// @vitest-environment happy-dom
/**
 * Web bench 2026-10-13: a text arrived while the chat list was open, and the
 * page reloaded before the SDK saved its sync store (it saves every 5 min).
 * The SDK started from the older cache, PREPARED ran a full room refresh with
 * the cached count 0, and Dexie turned the room's 1 into 0 and moved the read
 * watermark onto the unread text. The first /sync brought the 1 back, but the
 * watermark stayed, and the room opened without the unread banner.
 * Room refreshes now leave Dexie unread counts alone until a /sync from the
 * server; the post-sync heal (syncAllUnreadFromMatrix) reconciles them.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { setActivePinia } from "pinia";
import { createTestingPinia } from "@pinia/testing";
import { hexEncode } from "@/shared/lib/matrix/functions";

let sdkUnread = 0;
const mxRoom = {
  roomId: "!r0:s",
  name: "Room 0",
  selfMembership: "join",
  currentState: { getStateEvents: () => [] },
  getLiveTimeline: () => ({ getEvents: () => [] }),
  getUnreadNotificationCount: () => sdkUnread,
};

const kit = {
  client: { getUserId: () => "@me:s" },
  isTetatetChat: vi.fn(() => true),
  getRoomMembers: vi.fn(() => [
    { userId: `@${hexEncode("Meaddr")}:s`, membership: "join", rawDisplayName: "Me" },
    { userId: `@${hexEncode("Peeraddr")}:s`, membership: "join", rawDisplayName: "Peer" },
  ]),
};

let liveSync = false;
const mockMatrixService = {
  getUserId: vi.fn(() => `@${hexEncode("Meaddr")}:s`),
  getRoom: vi.fn(() => mxRoom),
  getRooms: vi.fn(() => [mxRoom]),
  isReady: vi.fn(() => true),
  hasLiveSync: () => liveSync,
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

type RoomUpdate = { id: string; serverUnreadCount?: number; unreadCount?: number };

function makeDbKit() {
  const bulkSyncRooms = vi.fn<(rooms: RoomUpdate[]) => Promise<void>>(async () => {});
  const roomUpdate = vi.fn(async () => 1);
  const dbKit = {
    db: {
      transaction: vi.fn(async (_mode: string, _table: unknown, fn: () => Promise<void>) => fn()),
      rooms: { update: roomUpdate },
    },
    rooms: {
      bulkSyncRooms,
      getAllRooms: vi.fn(async () => [{
        id: "!r0:s", name: "Room 0", isGroup: false, members: [], membership: "join",
        unreadCount: 1, lastMessageTimestamp: 200, lastReadInboundTs: 100, lastReadOutboundTs: 0,
        updatedAt: 200, syncedAt: 0, hasMoreHistory: true, topic: "",
      }]),
      observeRoomChanges: vi.fn(() => () => {}),
    },
    eventWriter: { enableBatching: vi.fn(), setClearedAtTs: vi.fn(), getClearedAtTs: vi.fn(() => undefined) },
  };
  return { dbKit, bulkSyncRooms, roomUpdate };
}

const lastWriteOf = (spy: ReturnType<typeof makeDbKit>["bulkSyncRooms"], roomId: string) =>
  spy.mock.calls.flatMap((c) => c[0]).filter((u) => u.id === roomId).pop();

describe("room refreshes and the SDK's cached unread counts", () => {
  let store: ReturnType<typeof useChatStore>;
  let bulkSyncRooms: ReturnType<typeof makeDbKit>["bulkSyncRooms"];
  let roomUpdate: ReturnType<typeof makeDbKit>["roomUpdate"];

  beforeEach(async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    // The post-sync heal finds no Dexie table in this kit and says so.
    vi.spyOn(console, "warn").mockImplementation(() => {});
    // Wiring the kit runs the startup heal at once: start each test before any /sync.
    liveSync = false;
    sdkUnread = 0;
    setActivePinia(createTestingPinia({ stubActions: false }));
    store = useChatStore();
    const made = makeDbKit();
    bulkSyncRooms = made.bulkSyncRooms;
    roomUpdate = made.roomUpdate;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    store.setChatDbKit(made.dbKit as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    store.setHelpers(kit as any, { rooms: {} } as any);
    await vi.waitFor(() => expect(made.dbKit.rooms.getAllRooms).toHaveBeenCalled());
    await Promise.resolve();
  });

  it("a full refresh before any /sync keeps the stored count", async () => {
    liveSync = false;
    sdkUnread = 0;
    store.refreshRoomsNow();
    await vi.waitFor(() => expect(lastWriteOf(bulkSyncRooms, "!r0:s")).toBeDefined());
    expect(lastWriteOf(bulkSyncRooms, "!r0:s")?.serverUnreadCount).toBeUndefined();
  });

  it("a full refresh after a /sync still reconciles with the SDK", async () => {
    liveSync = true;
    sdkUnread = 2;
    store.refreshRoomsNow();
    await vi.waitFor(() => expect(lastWriteOf(bulkSyncRooms, "!r0:s")).toBeDefined());
    expect(lastWriteOf(bulkSyncRooms, "!r0:s")?.serverUnreadCount).toBe(2);
  });

  it("an incremental refresh before any /sync keeps the stored count", async () => {
    liveSync = false;
    sdkUnread = 0;
    store.refreshRoomsNow();
    await vi.waitFor(() => expect(lastWriteOf(bulkSyncRooms, "!r0:s")).toBeDefined());
    bulkSyncRooms.mockClear();
    store.markRoomChanged("!r0:s");
    store.refreshRooms("SYNCING");
    await vi.waitFor(() => expect(lastWriteOf(bulkSyncRooms, "!r0:s")).toBeDefined(), { timeout: 2000 });
    expect(lastWriteOf(bulkSyncRooms, "!r0:s")?.serverUnreadCount).toBeUndefined();
  });

  it("an incremental refresh after a /sync still reconciles with the SDK", async () => {
    liveSync = false;
    sdkUnread = 0;
    store.refreshRoomsNow();
    await vi.waitFor(() => expect(lastWriteOf(bulkSyncRooms, "!r0:s")).toBeDefined());
    bulkSyncRooms.mockClear();
    liveSync = true;
    sdkUnread = 3;
    store.markRoomChanged("!r0:s");
    store.refreshRooms("SYNCING");
    await vi.waitFor(() => expect(lastWriteOf(bulkSyncRooms, "!r0:s")).toBeDefined(), { timeout: 2000 });
    expect(lastWriteOf(bulkSyncRooms, "!r0:s")?.serverUnreadCount).toBe(3);
  });

  // Review 2026-10-13: a refresh before the /sync may already have consumed
  // the room's change, and a rebuilt Matrix client replays its store again
  // after the one-time startup heal. The first refresh after the /sync heals
  // every room, not only the changed ones.
  it("the first refresh after a /sync reconciles rooms it did not rebuild", async () => {
    liveSync = false;
    sdkUnread = 0;
    store.refreshRoomsNow();
    await vi.waitFor(() => expect(lastWriteOf(bulkSyncRooms, "!r0:s")).toBeDefined());
    liveSync = true;
    sdkUnread = 3;
    store.refreshRooms("SYNCING");
    // Within 1.5 s: the startup heal retries only 3 s after the kit was wired.
    await vi.waitFor(() => expect(roomUpdate).toHaveBeenCalledWith("!r0:s", { unreadCount: 3 }), { timeout: 1500 });
  });
});
