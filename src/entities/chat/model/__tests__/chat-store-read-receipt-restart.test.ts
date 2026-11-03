// @vitest-environment happy-dom
/**
 * Samsung 2026-10-14: a chat read with no network kept its read receipt in
 * memory only. A swipe before the network came back lost it; after the
 * restart the server's old count brought the read chat back as unread, and
 * the next message showed 3 unread for one. Unacknowledged receipts now live
 * in storage per account, go out after the first /sync by the event id that
 * Dexie holds for the read position, and keep the server's stale count off
 * the room until the server has them.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { setActivePinia } from "pinia";
import { createTestingPinia } from "@pinia/testing";
import { hexEncode } from "@/shared/lib/matrix/functions";
import { useAuthStore } from "@/entities/auth";

const KEY = "chat_pending_read_receipts:Meaddr";
let sdkUnread = 3;
const timelineEvent = { getId: () => "$e1", getTs: () => 100, getRoomId: () => "!r0:s" };
const mxRoom = {
  roomId: "!r0:s",
  name: "Room 0",
  selfMembership: "join",
  currentState: { getStateEvents: () => [] },
  getLiveTimeline: () => ({ getEvents: () => [timelineEvent] }),
  getUnreadNotificationCount: () => sdkUnread,
};

let liveSync = false;
const sendReadReceipt = vi.fn(async () => false);
const sendReadReceiptById = vi.fn(async () => true);
const mockMatrixService = {
  getUserId: vi.fn(() => `@${hexEncode("Meaddr")}:s`),
  getRoom: vi.fn(() => mxRoom),
  getRooms: vi.fn(() => [mxRoom]),
  isReady: vi.fn(() => true),
  hasLiveSync: () => liveSync,
  sendReadReceipt,
  sendReadReceiptById,
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

const matrixKit = {
  client: { getUserId: () => "@me:s" },
  isTetatetChat: vi.fn(() => true),
  getRoomMembers: vi.fn(() => []),
};

function makeDbKit() {
  const roomUpdate = vi.fn(async () => 1);
  const bulkSyncRooms = vi.fn<(rooms: Array<{ id: string; serverUnreadCount?: number }>) => Promise<void>>(async () => {});
  const dbKit = {
    db: {
      transaction: vi.fn(async (_mode: string, _table: unknown, fn: () => Promise<void>) => fn()),
      rooms: { update: roomUpdate },
    },
    rooms: {
      bulkSyncRooms,
      getAllRooms: vi.fn(async () => [{
        id: "!r0:s", name: "Room 0", isGroup: false, members: [], membership: "join",
        unreadCount: 0, lastMessageTimestamp: 200, lastReadInboundTs: 200, lastReadOutboundTs: 0,
        updatedAt: 200, syncedAt: 0, hasMoreHistory: true, topic: "",
      }]),
      observeRoomChanges: vi.fn(() => () => {}),
      markAsRead: vi.fn(async () => true),
    },
    messages: {
      getLastInboundTimestamp: vi.fn(async () => 100),
      getLastMessageAtOrBefore: vi.fn(async () => ({ eventId: "$e2", timestamp: 200 })),
    },
    eventWriter: { enableBatching: vi.fn(), setClearedAtTs: vi.fn(), getClearedAtTs: vi.fn(() => undefined) },
  };
  return { dbKit, roomUpdate, bulkSyncRooms };
}

describe("read receipts the server has not acknowledged", () => {
  let store: ReturnType<typeof useChatStore>;
  let made: ReturnType<typeof makeDbKit>;

  const wire = async () => {
    store.bindAccountKeys("Meaddr");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    store.setChatDbKit(made.dbKit as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    store.setHelpers(matrixKit as any, { rooms: {} } as any);
    await vi.waitFor(() => expect(made.dbKit.rooms.getAllRooms).toHaveBeenCalled());
    await Promise.resolve();
  };

  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    localStorage.clear();
    liveSync = false;
    sdkUnread = 3;
    sendReadReceipt.mockClear();
    sendReadReceiptById.mockClear();
    sendReadReceiptById.mockImplementation(async () => true);
    setActivePinia(createTestingPinia({ stubActions: false }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (useAuthStore() as any).address = "Meaddr";
    store = useChatStore();
    made = makeDbKit();
  });

  it("keeps a receipt that could not go out in storage", async () => {
    liveSync = true;
    await wire();
    store.markRoomAsRead("!r0:s");
    await vi.waitFor(() => expect(sendReadReceipt).toHaveBeenCalled());
    await vi.waitFor(() => expect(JSON.parse(localStorage.getItem(KEY) ?? "{}")["!r0:s"]?.ts).toBe(100));
  });

  // Review 2026-10-14: the first send's success dropped a newer read that the
  // 3 s cooldown had queued meanwhile, so the server stayed behind.
  it("keeps a newer read queued while an older receipt is on its way", async () => {
    liveSync = true;
    await wire();
    let release: (ok: boolean) => void = () => {};
    sendReadReceipt.mockImplementationOnce(() => new Promise<boolean>((r) => { release = r; }));
    made.dbKit.messages.getLastInboundTimestamp.mockResolvedValueOnce(100).mockResolvedValueOnce(150);
    store.markRoomAsRead("!r0:s");
    await vi.waitFor(() => expect(sendReadReceipt).toHaveBeenCalledTimes(1));
    store.markRoomAsRead("!r0:s");
    await vi.waitFor(() => expect(JSON.parse(localStorage.getItem(KEY) ?? "{}")["!r0:s"]?.ts).toBe(150));
    release(true);
    await new Promise((r) => setTimeout(r, 50));
    expect(JSON.parse(localStorage.getItem(KEY) ?? "{}")["!r0:s"]?.ts).toBe(150);
  });

  // The auth store binds the account keys only after initMatrix, so a push
  // tap can read a chat before that.
  it("keeps a read queued before the account keys are bound", async () => {
    liveSync = true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    store.setChatDbKit(made.dbKit as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    store.setHelpers(matrixKit as any, { rooms: {} } as any);
    await vi.waitFor(() => expect(made.dbKit.rooms.getAllRooms).toHaveBeenCalled());
    store.markRoomAsRead("!r0:s");
    await vi.waitFor(() => expect(sendReadReceipt).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 50));
    store.bindAccountKeys("Meaddr");
    expect(JSON.parse(localStorage.getItem(KEY) ?? "{}")["!r0:s"]?.ts).toBe(100);
  });

  it("sends a receipt kept from the last run after the first /sync, by the event id Dexie holds", async () => {
    localStorage.setItem(KEY, JSON.stringify({ "!r0:s": { ts: 200, at: Date.now() - 60_000 } }));
    await wire();
    store.refreshRooms("PREPARED");
    await new Promise((r) => setTimeout(r, 400));
    expect(sendReadReceiptById).not.toHaveBeenCalled();

    liveSync = true;
    store.refreshRooms("SYNCING");
    await vi.waitFor(() => expect(sendReadReceiptById).toHaveBeenCalledWith("!r0:s", "$e2"));
    expect(made.dbKit.messages.getLastMessageAtOrBefore).toHaveBeenCalledWith("!r0:s", 200, undefined);
    await vi.waitFor(() => expect(localStorage.getItem(KEY)).toBeNull());

    // Review 2026-10-14: the receipt's echo zeroes the room, and refreshes
    // skipped it while pending; messages that came in meanwhile must count.
    sdkUnread = 2;
    made.bulkSyncRooms.mockClear();
    await vi.waitFor(() => {
      const writes = made.bulkSyncRooms.mock.calls.flatMap((c) => c[0]).filter((u) => u.id === "!r0:s");
      expect(writes.some((u) => u.serverUnreadCount === 2)).toBe(true);
    }, { timeout: 5000 });
  });

  it("keeps the server's stale count off a room whose receipt is still on its way", async () => {
    localStorage.setItem(KEY, JSON.stringify({ "!r0:s": { ts: 200, at: Date.now() - 60_000 } }));
    sendReadReceiptById.mockImplementation(async () => false);
    await wire();
    store.refreshRoomsNow();
    await vi.waitFor(() => expect(made.bulkSyncRooms).toHaveBeenCalled());
    liveSync = true;
    store.markRoomChanged("!r0:s");
    store.refreshRooms("SYNCING");
    await vi.waitFor(() => expect(sendReadReceiptById).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 200));
    // Neither the heal nor the refresh copies the server's 3 over the local read.
    expect(made.roomUpdate).not.toHaveBeenCalledWith("!r0:s", { unreadCount: 3 });
    const writes = made.bulkSyncRooms.mock.calls.flatMap((c) => c[0]).filter((u) => u.id === "!r0:s");
    expect(writes.every((u) => u.serverUnreadCount === undefined)).toBe(true);
    expect(JSON.parse(localStorage.getItem(KEY) ?? "{}")["!r0:s"]?.ts).toBe(200);
  });
});
