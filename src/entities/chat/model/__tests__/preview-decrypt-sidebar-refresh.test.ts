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

function makeKit() {
  return {
    rooms: {
      getAllRooms: vi.fn(async () => [makeLocalRoom()]),
      observeRoomChanges: vi.fn((_cb: (changes: RoomChange[]) => void) => () => {}),
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

  it("leaves the sidebar row untouched when decryption fails", async () => {
    decryptEvent.mockRejectedValue(new Error("getusersinfo timed out"));
    store.retryEncryptedPreviews();

    await vi.waitFor(() => expect(decryptEvent).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 50));
    expect(sidebarPreview(store)).toBe("[encrypted]");
  });
});
