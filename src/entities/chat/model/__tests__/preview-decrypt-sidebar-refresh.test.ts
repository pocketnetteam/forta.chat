// @vitest-environment happy-dom
/**
 * Regression: the sidebar renders from Dexie rows (sortedRooms), but
 * decryptRoomPreviews only wrote decryptedPreviewCache + rooms.value. Once
 * Dexie is active a rooms.value change no longer rebuilds sortedRooms, so the
 * decrypted preview stayed "[encrypted]" in the chat list until an unrelated
 * Dexie write touched the room — in practice, until the chat was opened.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { setActivePinia } from "pinia";
import { createTestingPinia } from "@pinia/testing";
import { makeRoom, makeMsg } from "@/test-utils";
import type { LocalRoom, RoomChange } from "@/shared/lib/local-db";

const ROOM_ID = "!enc-room:server";

const ENCRYPTED_EVENT = {
  event: {
    type: "m.room.message",
    sender: "@peer:server",
    content: { msgtype: "m.encrypted", body: "b64..." },
    event_id: "$e1",
    origin_server_ts: 1000,
  },
};

const mxRoom = {
  roomId: ROOM_ID,
  getLiveTimeline: () => ({ getEvents: () => [ENCRYPTED_EVENT] }),
};

const mockMatrixService = {
  getUserId: vi.fn(() => "@me:server"),
  getRoom: vi.fn(() => mxRoom),
  getRooms: vi.fn(() => [mxRoom]),
  isReady: vi.fn(() => true),
  getRoomAccountData: vi.fn(() => null),
  getIgnoredMatrixUserIds: vi.fn(() => [] as string[]),
  matrixId: vi.fn((id: string) => id),
  isMe: vi.fn(() => false),
  sendReadReceipt: vi.fn(async () => true),
  kit: {
    client: { getUserId: () => "@me:server" },
    isTetatetChat: vi.fn(() => true),
    getRoomMembers: vi.fn(() => []),
  },
};
vi.mock("@/entities/matrix", () => ({
  getMatrixClientService: vi.fn(() => mockMatrixService),
}));

vi.mock("@/shared/lib/cache/chat-cache", () => ({
  cacheRooms: vi.fn(() => Promise.resolve()),
  getCachedRooms: vi.fn(() => Promise.resolve([])),
  cacheMessages: vi.fn(() => Promise.resolve()),
  getCachedMessages: vi.fn(() => Promise.resolve([])),
  getCacheTimestamp: vi.fn(() => Promise.resolve(null)),
}));

import { useChatStore } from "../chat-store";

function makeLocalRoom(): LocalRoom {
  return {
    id: ROOM_ID,
    name: "Peer",
    isGroup: false,
    members: ["me", "peer"],
    membership: "join",
    unreadCount: 2,
    lastReadInboundTs: 0,
    lastReadOutboundTs: 0,
    updatedAt: 1000,
    syncedAt: 1000,
    hasMoreHistory: true,
    isDeleted: false,
    deletedAt: null,
    deleteReason: null,
    lastMessageTimestamp: 1000,
    lastMessagePreview: "[encrypted]",
    lastMessageEventId: "$e1",
    lastMessageSenderId: "peer",
  } as LocalRoom;
}

let emitRoomChanges: (changes: RoomChange[]) => void = () => {};

function makeKit() {
  return {
    rooms: {
      getAllRooms: vi.fn(async () => [makeLocalRoom()]),
      observeRoomChanges: vi.fn((cb: (changes: RoomChange[]) => void) => {
        emitRoomChanges = cb;
        return () => {};
      }),
      bulkSyncRooms: vi.fn(async () => {}),
      getRoom: vi.fn(async () => undefined),
      updateOutboundWatermark: vi.fn(async () => {}),
    },
    messages: {
      getMessages: vi.fn(async () => []),
      patchUnresolvedReplies: vi.fn(async () => {}),
      updateReactions: vi.fn(async () => {}),
      getByEventIds: vi.fn(async () => []),
    },
    eventWriter: {
      enableBatching: vi.fn(),
      getClearedAtTs: vi.fn(() => undefined),
      setClearedAtTs: vi.fn(),
      flushWriteBuffer: vi.fn(() => Promise.resolve()),
      hasBufferedWritesFor: vi.fn(() => false),
    },
    db: { rooms: { update: vi.fn(async () => 1) } },
    retryRoomDecryption: vi.fn(),
  };
}

const sidebarPreview = (store: ReturnType<typeof useChatStore>) =>
  store.sortedRooms.find((r) => r.id === ROOM_ID)?.lastMessage?.content;

describe("chat-store — decrypted preview reaches the Dexie-backed sidebar", () => {
  let store: ReturnType<typeof useChatStore>;
  let decryptEvent: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    setActivePinia(createTestingPinia({ stubActions: false }));
    store = useChatStore();
    vi.clearAllMocks();
    mockMatrixService.isReady.mockReturnValue(true);
    mockMatrixService.getRooms.mockImplementation(() => [mxRoom]);
    mockMatrixService.getRoom.mockImplementation(() => mxRoom);
    mxRoom.getLiveTimeline = () => ({ getEvents: () => [ENCRYPTED_EVENT] });

    decryptEvent = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    store.setHelpers(mockMatrixService.kit as any, { rooms: { [ROOM_ID]: { decryptEvent } } } as any);
    store.addRoom(makeRoom({
      id: ROOM_ID,
      lastMessage: makeMsg({ roomId: ROOM_ID, content: "[encrypted]" }),
    }));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    store.setChatDbKit(makeKit() as any);
    await vi.waitFor(() => expect(sidebarPreview(store)).toBe("[encrypted]"));
  });

  it("updates the sidebar row without any further Dexie write", async () => {
    decryptEvent.mockResolvedValue({ body: "real preview", msgtype: "m.text" });
    store.retryEncryptedPreviews();

    await vi.waitFor(() => expect(sidebarPreview(store)).toBe("real preview"));
  });

  it("decrypts a row whose placeholder is only in Dexie (cold start, rooms.value not built)", async () => {
    const room = store.rooms.find((r) => r.id === ROOM_ID)!;
    room.lastMessage = { ...room.lastMessage!, content: "older text" };
    decryptEvent.mockResolvedValue({ body: "real preview", msgtype: "m.text" });
    store.setVisibleSidebarRooms([ROOM_ID]);

    await vi.waitFor(() => expect(sidebarPreview(store)).toBe("real preview"));
  });

  it("decrypts the event the Dexie row points at, not just the newest one", async () => {
    const OLDER = { event: { ...ENCRYPTED_EVENT.event, event_id: "$e1" } };
    const NEWER = { event: { ...ENCRYPTED_EVENT.event, event_id: "$e2", origin_server_ts: 2000 } };
    mxRoom.getLiveTimeline = () => ({ getEvents: () => [OLDER, NEWER] });
    decryptEvent.mockImplementation(async (raw: Record<string, unknown>) =>
      ({ body: `plain ${raw.event_id as string}`, msgtype: "m.text" }));
    store.setVisibleSidebarRooms([ROOM_ID]);

    await vi.waitFor(() => expect(sidebarPreview(store)).toBe("plain $e1"));
  });

  it("does not decrypt an older event when the row's event is not in the SDK timeline yet", async () => {
    // Dexie row points at $e1 @1000 (makeLocalRoom); the SDK only holds an older one
    const OLDER = { event: { ...ENCRYPTED_EVENT.event, event_id: "$e0", origin_server_ts: 500 } };
    mxRoom.getLiveTimeline = () => ({ getEvents: () => [OLDER] });
    decryptEvent.mockResolvedValue({ body: "stale text", msgtype: "m.text" });
    store.setVisibleSidebarRooms([ROOM_ID]);

    await new Promise((r) => setTimeout(r, 50));
    expect(decryptEvent).not.toHaveBeenCalled();
    expect(sidebarPreview(store)).toBe("[encrypted]");
  });

  it("a newer message's placeholder never shows the previous message's text", async () => {
    decryptEvent.mockImplementation(async (raw: Record<string, unknown>) =>
      ({ body: `plain ${raw.event_id as string}`, msgtype: "m.text" }));
    store.setVisibleSidebarRooms([ROOM_ID]);
    await vi.waitFor(() => expect(sidebarPreview(store)).toBe("plain $e1"));

    // A new encrypted message lands in the row before its decrypt
    let releaseNew!: () => void;
    const newGate = new Promise<void>((r) => { releaseNew = r; });
    decryptEvent.mockImplementation(async (raw: Record<string, unknown>) => {
      await newGate;
      return { body: `plain ${raw.event_id as string}`, msgtype: "m.text" };
    });
    const NEWER = { event: { ...ENCRYPTED_EVENT.event, event_id: "$e2", origin_server_ts: 2000 } };
    mxRoom.getLiveTimeline = () => ({ getEvents: () => [ENCRYPTED_EVENT, NEWER] });
    emitRoomChanges([{
      type: "upsert",
      room: { ...makeLocalRoom(), lastMessageEventId: "$e2", lastMessageTimestamp: 2000 },
    }]);

    await vi.waitFor(() => expect(sidebarPreview(store)).toBe("[encrypted]"));
    store.setVisibleSidebarRooms([ROOM_ID]);
    releaseNew();
    await vi.waitFor(() => expect(sidebarPreview(store)).toBe("plain $e2"));
  });

  it("leaves the sidebar row untouched when decryption fails", async () => {
    decryptEvent.mockRejectedValue(new Error("getusersinfo timed out"));
    store.retryEncryptedPreviews();

    await vi.waitFor(() => expect(decryptEvent).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 50));
    expect(sidebarPreview(store)).toBe("[encrypted]");
  });
});
