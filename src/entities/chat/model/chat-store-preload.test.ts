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
  getCacheTimestamp: vi.fn(() => Promise.resolve(null)),
}));

// ── Mock matrix client service ────────────────────────────────────
vi.mock("@/entities/matrix", () => ({
  getMatrixClientService: vi.fn(() => ({
    isReady: () => true,
    getUserId: () => "@mock:s",
    getRoom: () => null,
    getRooms: () => [],
  })),
  MatrixClientService: vi.fn(),
  resetMatrixClientService: vi.fn(),
}));

import { getCachedMessages } from "@/shared/lib/cache/chat-cache";
import { getMatrixClientService } from "@/entities/matrix";

const mockedGetCachedMessages = vi.mocked(getCachedMessages);
const mockedGetMatrixClientService = vi.mocked(getMatrixClientService);

/** Wait for a condition to be true (polls every 10ms, max 2s). */
async function waitFor(fn: () => boolean, timeout = 2000) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("waitFor timed out");
    await new Promise(r => setTimeout(r, 10));
  }
}

describe("preloadVisibleRooms", () => {
  let store: ReturnType<typeof useChatStore>;

  beforeEach(() => {
    vi.clearAllMocks();
    // Stub requestIdleCallback so idle tasks run synchronously in tests
    vi.stubGlobal("requestIdleCallback", (cb: () => void) => { cb(); return 0; });
    setActivePinia(createTestingPinia({ stubActions: false }));
    store = useChatStore();

    // Provide a matrix service mock with getRooms returning a fake room
    // so preloadVisibleRooms sees SDK as ready.
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
      getRoom: vi.fn(() => ({ getLiveTimeline: () => ({ getEvents: () => [] }), currentState: { getStateEvents: () => [] } })),
      isReady: vi.fn(() => true),
      getUserId: vi.fn(() => "@mock:s"),
      getRooms: vi.fn(() => [{ roomId: "!fake:s" }]),
    } as any);
  });

  it("enqueues neighbor rooms via ensureRoomsLoaded when active room is set", async () => {
    store.rooms = [
      makeRoom({ id: "!r1:s", updatedAt: 300 }),
      makeRoom({ id: "!r2:s", updatedAt: 200 }),
      makeRoom({ id: "!r3:s", updatedAt: 100 }),
    ];
    store.activeRoomId = "!r1:s";

    await store.preloadVisibleRooms();

    // !r2:s is the next neighbor after active !r1:s — should be tracked in roomFetchStates
    await waitFor(() => store.roomFetchStates.get("!r2:s")?.status === "success");
    expect(store.roomFetchStates.get("!r2:s")?.status).toBe("success");
  });

  it("loads from cache for rooms outside neighbor range", async () => {
    store.rooms = [
      makeRoom({ id: "!r1:s", updatedAt: 300 }),
      makeRoom({ id: "!r2:s", updatedAt: 200 }),
      makeRoom({ id: "!r3:s", updatedAt: 100 }),
    ];
    store.activeRoomId = "!r1:s";

    await store.preloadVisibleRooms();
    // Allow microtasks (requestIdleCallback stub runs synchronously)
    await new Promise(r => setTimeout(r, 0));

    // !r3:s is outside neighbor range — only cache load attempted
    expect(mockedGetCachedMessages).toHaveBeenCalledWith("!r3:s");
  });

  it("loads from cache first when room has no messages yet", async () => {
    store.rooms = [
      makeRoom({ id: "!active:s", updatedAt: 300 }),
      makeRoom({ id: "!r1:s", updatedAt: 200 }),
    ];
    store.activeRoomId = "!active:s";

    const cachedMsg = makeMsg({ roomId: "!r1:s", content: "from cache" });
    mockedGetCachedMessages.mockResolvedValue([cachedMsg]);

    await store.preloadVisibleRooms();

    // Cache was consulted for the neighbor room (room had no messages)
    expect(mockedGetCachedMessages).toHaveBeenCalledWith("!r1:s");
  });

  it("skips cache load when room already has messages", async () => {
    store.rooms = [
      makeRoom({ id: "!active:s", updatedAt: 300 }),
      makeRoom({ id: "!r1:s", updatedAt: 200 }),
    ];
    store.activeRoomId = "!active:s";
    store.addMessage("!r1:s", makeMsg({ roomId: "!r1:s" }));

    await store.preloadVisibleRooms();
    await waitFor(() => store.roomFetchStates.get("!r1:s")?.status === "success");

    // Cache not called — messages already present
    expect(mockedGetCachedMessages).not.toHaveBeenCalledWith("!r1:s");
    // But room was still processed by ensureRoomsLoaded
    expect(store.roomFetchStates.get("!r1:s")?.status).toBe("success");
  });

  it("skips the active room from neighbor preload", async () => {
    store.rooms = [
      makeRoom({ id: "!active:s", updatedAt: 300 }),
      makeRoom({ id: "!other:s", updatedAt: 200 }),
    ];
    store.activeRoomId = "!active:s";

    await store.preloadVisibleRooms();
    await waitFor(() => store.roomFetchStates.get("!other:s")?.status === "success");

    expect(store.roomFetchStates.has("!active:s")).toBe(false);
    expect(store.roomFetchStates.get("!other:s")?.status).toBe("success");
  });

  it("skips invite rooms", async () => {
    store.rooms = [
      makeRoom({ id: "!active:s", updatedAt: 400 }),
      makeRoom({ id: "!joined:s", updatedAt: 300, membership: "join" }),
      makeRoom({ id: "!invited:s", updatedAt: 200, membership: "invite" }),
    ];
    store.activeRoomId = "!active:s";

    await store.preloadVisibleRooms();
    await waitFor(() => store.roomFetchStates.get("!joined:s")?.status === "success");

    expect(store.roomFetchStates.has("!invited:s")).toBe(false);
    expect(store.roomFetchStates.get("!joined:s")?.status).toBe("success");
  });

  it("only runs once (idempotent)", async () => {
    store.rooms = [
      makeRoom({ id: "!active:s", updatedAt: 300 }),
      makeRoom({ id: "!r1:s", updatedAt: 200 }),
    ];
    store.activeRoomId = "!active:s";

    await store.preloadVisibleRooms();
    await waitFor(() => store.roomFetchStates.get("!r1:s")?.status === "success");

    const cacheCallCount = mockedGetCachedMessages.mock.calls.length;
    await store.preloadVisibleRooms(); // no-op (preloadDone = true)
    await new Promise(r => setTimeout(r, 100));

    // Second call should not trigger any additional cache calls
    expect(mockedGetCachedMessages).toHaveBeenCalledTimes(cacheCallCount);
  });

  it("silently handles errors and continues", async () => {
    store.rooms = [
      makeRoom({ id: "!active:s", updatedAt: 400 }),
      makeRoom({ id: "!fail:s", updatedAt: 300 }),
      makeRoom({ id: "!ok:s", updatedAt: 200 }),
    ];
    store.activeRoomId = "!active:s";

    // Cache throws for first room
    mockedGetCachedMessages.mockImplementation(async (roomId: string) => {
      if (roomId === "!fail:s") throw new Error("cache corrupted");
      return [makeMsg({ roomId })];
    });

    await store.preloadVisibleRooms();
    // Allow idle callbacks
    await new Promise(r => setTimeout(r, 0));

    // !ok:s is outside neighbor range but should still get cache-loaded
    expect(mockedGetCachedMessages).toHaveBeenCalledWith("!ok:s");
  });

  it("combines filters: skips active and invite, processes neighbors", async () => {
    store.rooms = [
      makeRoom({ id: "!active:s", updatedAt: 500 }),
      makeRoom({ id: "!normal:s", updatedAt: 400 }),
      makeRoom({ id: "!invite:s", updatedAt: 300, membership: "invite" }),
      makeRoom({ id: "!also-normal:s", updatedAt: 200 }),
    ];
    store.activeRoomId = "!active:s";

    await store.preloadVisibleRooms();
    await waitFor(() => store.roomFetchStates.get("!normal:s")?.status === "success");

    expect(store.roomFetchStates.has("!active:s")).toBe(false);
    expect(store.roomFetchStates.has("!invite:s")).toBe(false);
    expect(store.roomFetchStates.get("!normal:s")?.status).toBe("success");
  });
});
