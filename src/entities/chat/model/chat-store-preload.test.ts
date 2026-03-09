import { describe, it, expect, beforeEach, vi } from "vitest";
import { setActivePinia } from "pinia";
import { createTestingPinia } from "@pinia/testing";
import { useChatStore } from "./chat-store";
import { makeMsg, makeRoom } from "@/test-utils";

// ── Mock chat-cache ──────────────────────────────────────────────
vi.mock("@/shared/lib/cache/chat-cache", () => ({
  cacheRooms: vi.fn(() => Promise.resolve()),
  getCachedRooms: vi.fn(() => Promise.resolve([])),
  cacheMessages: vi.fn(() => Promise.resolve()),
  getCachedMessages: vi.fn(() => Promise.resolve([])),
}));

import { getCachedMessages } from "@/shared/lib/cache/chat-cache";
import { getMatrixClientService } from "@/entities/matrix";

const mockedGetCachedMessages = vi.mocked(getCachedMessages);
const mockedGetMatrixClientService = vi.mocked(getMatrixClientService);

describe("preloadVisibleRooms", () => {
  let store: ReturnType<typeof useChatStore>;
  let mockGetRoom: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    setActivePinia(createTestingPinia({ stubActions: false }));
    store = useChatStore();

    // Provide getRoom on the matrix service mock so loadRoomMessages
    // doesn't throw. Returning null makes it exit early (room not found).
    mockGetRoom = vi.fn(() => null);
    mockedGetMatrixClientService.mockReturnValue({
      kit: {
        client: { sendEvent: vi.fn(), redactEvent: vi.fn(), scrollback: vi.fn(), setRoomTopic: vi.fn(), sendStateEvent: vi.fn(), getUserId: vi.fn(() => "@mock:s") },
        isTetatetChat: vi.fn(() => true),
        getRoomMembers: vi.fn(() => []),
      },
      sendText: vi.fn(),
      sendEncryptedText: vi.fn(),
      sendFile: vi.fn(),
      redactEvent: vi.fn(),
      scrollback: vi.fn(),
      joinRoom: vi.fn(),
      createRoom: vi.fn(),
      getRoom: mockGetRoom,
      isReady: vi.fn(() => true),
      getUserId: vi.fn(() => "@mock:s"),
      getRooms: vi.fn(() => []),
    } as any);
  });

  it("calls loadRoomMessages for every preloaded room", async () => {
    store.rooms = [
      makeRoom({ id: "!r1:s", updatedAt: 300 }),
      makeRoom({ id: "!r2:s", updatedAt: 200 }),
    ];

    await store.preloadVisibleRooms();

    // loadRoomMessages calls getRoom for each room
    expect(mockGetRoom).toHaveBeenCalledWith("!r1:s");
    expect(mockGetRoom).toHaveBeenCalledWith("!r2:s");
  });

  it("loads from cache first when room has no messages yet", async () => {
    store.rooms = [makeRoom({ id: "!r1:s", updatedAt: 300 })];

    const cachedMsg = makeMsg({ roomId: "!r1:s", content: "from cache" });
    mockedGetCachedMessages.mockResolvedValue([cachedMsg]);

    await store.preloadVisibleRooms();

    // Cache was consulted (room had no messages)
    expect(mockedGetCachedMessages).toHaveBeenCalledWith("!r1:s");
    // Messages populated from cache (loadRoomMessages was a no-op because getRoom→null)
    expect(store.messages["!r1:s"]).toHaveLength(1);
    expect(store.messages["!r1:s"][0].content).toBe("from cache");
  });

  it("skips cache load when room already has messages", async () => {
    store.rooms = [makeRoom({ id: "!r1:s", updatedAt: 300 })];
    store.addMessage("!r1:s", makeMsg({ roomId: "!r1:s" }));

    await store.preloadVisibleRooms();

    // Cache not called — messages already present
    expect(mockedGetCachedMessages).not.toHaveBeenCalled();
    // But loadRoomMessages was still attempted (to get fresh data)
    expect(mockGetRoom).toHaveBeenCalledWith("!r1:s");
  });

  it("skips the active room", async () => {
    store.rooms = [
      makeRoom({ id: "!active:s", updatedAt: 300 }),
      makeRoom({ id: "!other:s", updatedAt: 200 }),
    ];
    store.activeRoomId = "!active:s";

    await store.preloadVisibleRooms();

    expect(mockGetRoom).not.toHaveBeenCalledWith("!active:s");
    expect(mockGetRoom).toHaveBeenCalledWith("!other:s");
  });

  it("skips invite rooms", async () => {
    store.rooms = [
      makeRoom({ id: "!joined:s", updatedAt: 300, membership: "join" }),
      makeRoom({ id: "!invited:s", updatedAt: 200, membership: "invite" }),
    ];

    await store.preloadVisibleRooms();

    expect(mockGetRoom).not.toHaveBeenCalledWith("!invited:s");
    expect(mockGetRoom).toHaveBeenCalledWith("!joined:s");
  });

  it("only runs once (idempotent)", async () => {
    store.rooms = [makeRoom({ id: "!r1:s", updatedAt: 300 })];

    await store.preloadVisibleRooms();
    await store.preloadVisibleRooms(); // no-op

    expect(mockGetRoom).toHaveBeenCalledTimes(1);
  });

  it("limits to 15 rooms", async () => {
    store.rooms = Array.from({ length: 20 }, (_, i) =>
      makeRoom({ id: `!r${i}:s`, updatedAt: 2000 - i })
    );

    await store.preloadVisibleRooms();

    expect(mockGetRoom).toHaveBeenCalledTimes(15);
    expect(mockGetRoom).not.toHaveBeenCalledWith("!r15:s");
    expect(mockGetRoom).not.toHaveBeenCalledWith("!r19:s");
  });

  it("silently handles errors and continues to next room", async () => {
    store.rooms = [
      makeRoom({ id: "!fail:s", updatedAt: 300 }),
      makeRoom({ id: "!ok:s", updatedAt: 200 }),
    ];

    // Cache throws for first room
    mockedGetCachedMessages.mockImplementation(async (roomId: string) => {
      if (roomId === "!fail:s") throw new Error("cache corrupted");
      return [makeMsg({ roomId })];
    });

    await store.preloadVisibleRooms();

    // Second room still processed despite first room's error
    expect(mockGetRoom).toHaveBeenCalledWith("!ok:s");
    expect(store.messages["!ok:s"]).toHaveLength(1);
  });

  it("combines filters: skips active and invite, processes the rest", async () => {
    store.rooms = [
      makeRoom({ id: "!active:s", updatedAt: 500 }),
      makeRoom({ id: "!invite:s", updatedAt: 400, membership: "invite" }),
      makeRoom({ id: "!normal:s", updatedAt: 300 }),
      makeRoom({ id: "!also-normal:s", updatedAt: 200 }),
    ];
    store.activeRoomId = "!active:s";

    await store.preloadVisibleRooms();

    expect(mockGetRoom).not.toHaveBeenCalledWith("!active:s");
    expect(mockGetRoom).not.toHaveBeenCalledWith("!invite:s");
    expect(mockGetRoom).toHaveBeenCalledWith("!normal:s");
    expect(mockGetRoom).toHaveBeenCalledWith("!also-normal:s");
  });
});
