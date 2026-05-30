import { describe, it, expect, beforeEach, vi } from "vitest";
import { setActivePinia } from "pinia";
import { createTestingPinia } from "@pinia/testing";
import { makeRoom } from "@/test-utils";

const mockMatrixService = {
  getUserId: vi.fn(() => "@me:server"),
  getRoom: vi.fn(() => ({ selfMembership: "join" })),
  sendReadReceipt: vi.fn(async () => true),
  isReady: vi.fn(() => false),
  kit: {
    client: { getUserId: () => "@me:server" },
    isTetatetChat: vi.fn(() => true),
    getRoomMembers: vi.fn(() => []),
  },
};
vi.mock("@/entities/matrix", () => ({
  getMatrixClientService: vi.fn(() => mockMatrixService),
}));

import { useChatStore } from "../chat-store";

function makeKit() {
  const bulkSyncRooms = vi.fn(async () => {});
  const kit = {
    rooms: {
      bulkSyncRooms,
      // Stubs for `setChatDbKit` side-effects: chat-store kicks off
      // `initDexieRooms` and `observeRoomChanges` when the kit is wired.
      getAllRooms: vi.fn(async () => []),
      observeRoomChanges: vi.fn(() => () => {}),
    },
    eventWriter: { enableBatching: vi.fn() },
  };
  return { kit, bulkSyncRooms };
}

describe("chat-store — addRoom optimistic Dexie write (WEE-24)", () => {
  let store: ReturnType<typeof useChatStore>;

  beforeEach(() => {
    setActivePinia(createTestingPinia({ stubActions: false }));
    store = useChatStore();
    vi.clearAllMocks();
  });

  it("does not throw when no chat DB kit is wired (logged out / tests)", () => {
    // No setChatDbKit call — bulkSyncRooms must be skipped silently.
    expect(() => store.addRoom(makeRoom({ id: "!r:s" }))).not.toThrow();
    expect(store.rooms.find((r) => r.id === "!r:s")).toBeDefined();
  });

  it("mirrors a freshly created group to Dexie so it survives a restart", () => {
    const { kit, bulkSyncRooms } = makeKit();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    store.setChatDbKit(kit as any);

    const newGroup = makeRoom({
      id: "!new-group:s",
      name: "Project Alpha",
      isGroup: true,
      members: ["me", "alice", "bob"],
      avatar: "mxc://x",
      unreadCount: 0,
      updatedAt: 12345,
    });
    store.addRoom(newGroup);

    expect(bulkSyncRooms).toHaveBeenCalledTimes(1);
    const payload = bulkSyncRooms.mock.calls[0]?.[0];
    expect(Array.isArray(payload)).toBe(true);
    expect(payload).toHaveLength(1);
    expect(payload?.[0]).toMatchObject({
      id: "!new-group:s",
      name: "Project Alpha",
      isGroup: true,
      members: ["me", "alice", "bob"],
      membership: "join",
      isDeleted: false,
      hasMoreHistory: true,
      lastReadInboundTs: 0,
      lastReadOutboundTs: 0,
    });
  });

  it("re-issues the Dexie write when the same room is added again (acts as update)", () => {
    const { kit, bulkSyncRooms } = makeKit();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    store.setChatDbKit(kit as any);

    store.addRoom(makeRoom({ id: "!r:s", name: "Old name", updatedAt: 1 }));
    store.addRoom(makeRoom({ id: "!r:s", name: "New name", updatedAt: 2 }));

    expect(bulkSyncRooms).toHaveBeenCalledTimes(2);
    expect(bulkSyncRooms.mock.calls[1]?.[0]?.[0]).toMatchObject({
      id: "!r:s",
      name: "New name",
      updatedAt: 2,
    });
  });

  it("does not crash when the Dexie write rejects (warn-and-continue)", async () => {
    const bulkSyncRooms = vi.fn(async () => {
      throw new Error("db down");
    });
    const kit = {
      rooms: {
        bulkSyncRooms,
        getAllRooms: vi.fn(async () => []),
        observeRoomChanges: vi.fn(() => () => {}),
      },
      eventWriter: { enableBatching: vi.fn() },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    store.setChatDbKit(kit as any);

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    store.addRoom(makeRoom({ id: "!r:s" }));
    // Pinia/runtime should let the rejection settle without throwing
    await new Promise((r) => setImmediate(r));
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
