import { describe, it, expect, beforeEach, vi } from "vitest";
import { setActivePinia } from "pinia";
import { createTestingPinia } from "@pinia/testing";

// ── Mock MatrixClientService ───────────────────────────────────────
// getRoom() returns null: the SDK has not materialized this room yet, which is
// exactly the cold-start state a push tap lands in.
const mockMatrixService = {
  getUserId: vi.fn(() => "@me:server"),
  getRoom: vi.fn(() => null),
  isReady: vi.fn(() => false),
  getRoomAccountData: vi.fn(() => undefined),
  sendReadReceipt: vi.fn(async () => true),
  kit: {
    client: { getUserId: vi.fn(() => "@me:server") },
    isTetatetChat: vi.fn(() => false),
    getRoomMembers: vi.fn(() => []),
  },
};

vi.mock("@/entities/matrix", () => ({
  getMatrixClientService: vi.fn(() => mockMatrixService),
}));

import { useChatStore } from "./chat-store";

const GROUP_ROOM = {
  id: "!group:matrix.org",
  name: "Team",
  avatar: undefined,
  isGroup: true,
  members: ["me", "other"],
  membership: "join",
  unreadCount: 2,
  topic: undefined,
  updatedAt: 1_000,
  lastMessageTimestamp: 1_000,
  lastMessagePreview: "hello",
  lastMessageSenderId: "other",
  lastMessageEventId: "$e1",
  isDeleted: false,
};

function makeKit(rooms: unknown[]) {
  return {
    rooms: {
      getAllRooms: vi.fn(async () => rooms),
      observeRoomChanges: vi.fn(() => () => {}),
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
      clearUnread: vi.fn(async () => {}),
      writeMessages: vi.fn(() => Promise.resolve()),
      writeEdit: vi.fn(async () => {}),
    },
    db: { rooms: { update: vi.fn(async () => 1) } },
    retryRoomDecryption: vi.fn(),
  };
}

async function waitFor(fn: () => boolean, timeout = 2000) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("activeRoom falls back to Dexie (push-tap / deep-link room)", () => {
  let store: ReturnType<typeof useChatStore>;

  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    setActivePinia(createTestingPinia({ stubActions: false }));
    store = useChatStore();
  });

  it("resolves the room from Dexie when the Matrix-derived list has not materialized it", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    store.setChatDbKit(makeKit([GROUP_ROOM]) as any);
    await waitFor(() => store.sortedRooms.length === 1);
    store.rooms = []; // SDK-derived list still empty on a cold start

    store.setActiveRoom(GROUP_ROOM.id);

    expect(store.activeRoom?.id).toBe(GROUP_ROOM.id);
    expect(store.activeRoom?.name).toBe("Team");
    expect(store.activeRoom?.isGroup).toBe(true);
  });

  it("stays undefined for a room neither source knows, so the window keeps its loading state", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    store.setChatDbKit(makeKit([]) as any);
    await waitFor(() => store.sortedRooms.length === 0);

    store.setActiveRoom("!unknown:matrix.org");

    expect(store.activeRoom).toBeUndefined();
  });

  it("prefers the Matrix-derived room once sync delivers it", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    store.setChatDbKit(makeKit([GROUP_ROOM]) as any);
    await waitFor(() => store.sortedRooms.length === 1);
    store.setActiveRoom(GROUP_ROOM.id);
    expect(store.activeRoom?.name).toBe("Team");

    store.rooms = [
      {
        id: GROUP_ROOM.id,
        name: "Team (synced)",
        isGroup: true,
        members: ["me", "other"],
        membership: "join",
        unreadCount: 0,
        updatedAt: 2_000,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
    ];

    expect(store.activeRoom?.name).toBe("Team (synced)");
  });
});
