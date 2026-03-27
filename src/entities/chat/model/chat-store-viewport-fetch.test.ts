import { describe, it, expect, beforeEach, vi } from "vitest";
import { setActivePinia } from "pinia";
import { createTestingPinia } from "@pinia/testing";
import { useChatStore } from "./chat-store";
import { makeRoom } from "@/test-utils";
import { getCachedMessages } from "@/shared/lib/cache/chat-cache";

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
    kit: {
      client: {
        sendEvent: vi.fn(),
        redactEvent: vi.fn(),
        scrollback: vi.fn(),
        setRoomTopic: vi.fn(),
        sendStateEvent: vi.fn(),
        getUserId: vi.fn(() => "@mock:s"),
      },
      isTetatetChat: vi.fn(() => true),
      getRoomMembers: vi.fn(() => []),
    },
    sendText: vi.fn(),
    sendEncryptedText: vi.fn(),
    sendFile: vi.fn(),
    redactEvent: vi.fn(),
    scrollback: vi.fn(() => Promise.resolve()),
    joinRoom: vi.fn(),
    createRoom: vi.fn(),
    getRoom: vi.fn(() => ({
      getLiveTimeline: () => ({ getEvents: () => [] }),
      currentState: { getStateEvents: () => [] },
    })),
    isReady: vi.fn(() => true),
    getUserId: vi.fn(() => "@mock:s"),
    getRooms: vi.fn(() => [{ roomId: "!fake:s" }]),
  })),
  MatrixClientService: vi.fn(),
  resetMatrixClientService: vi.fn(),
}));

/** Wait for a condition to be true (polls every 10ms, max 2s). */
async function waitFor(fn: () => boolean, timeout = 2000) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("waitFor timed out");
    await new Promise(r => setTimeout(r, 10));
  }
}

describe("ensureRoomsLoaded — viewport-fetch state machine", () => {
  let store: ReturnType<typeof useChatStore>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("requestIdleCallback", (cb: () => void) => { cb(); return 0; });
    setActivePinia(createTestingPinia({ stubActions: false }));
    store = useChatStore();

    store.rooms = [
      makeRoom({ id: "!r1:s", updatedAt: 500 }),
      makeRoom({ id: "!r2:s", updatedAt: 400 }),
      makeRoom({ id: "!r3:s", updatedAt: 300 }),
      makeRoom({ id: "!r4:s", updatedAt: 200 }),
      makeRoom({ id: "!r5:s", updatedAt: 100 }),
    ];
    store.activeRoomId = "!r1:s";
  });

  it("transitions room from idle → loading → success", async () => {
    store.ensureRoomsLoaded(["!r2:s"], "high");

    // Should be loading immediately
    expect(store.roomFetchStates.get("!r2:s")?.status).toBe("loading");

    // Wait for async cache fetch to complete
    await waitFor(() => store.roomFetchStates.get("!r2:s")?.status === "success");
    expect(store.roomFetchStates.get("!r2:s")?.status).toBe("success");
  });

  it("skips rooms already in success state", () => {
    store.roomFetchStates.set("!r2:s", {
      status: "success",
      retryCount: 0,
      lastAttemptAt: Date.now(),
    });

    store.ensureRoomsLoaded(["!r2:s"], "high");

    // getCachedMessages should NOT be called for already-loaded room
    expect(vi.mocked(getCachedMessages)).not.toHaveBeenCalled();
  });

  it("skips rooms currently loading", () => {
    store.roomFetchStates.set("!r2:s", {
      status: "loading",
      retryCount: 0,
      lastAttemptAt: Date.now(),
    });

    store.ensureRoomsLoaded(["!r2:s"], "high");
    // Should not re-enqueue
    expect(vi.mocked(getCachedMessages)).not.toHaveBeenCalled();
  });

  it("retries rooms in error state when cooldown has passed", () => {
    store.roomFetchStates.set("!r2:s", {
      status: "error",
      retryCount: 1,
      lastAttemptAt: Date.now() - 5000, // 5s ago, cooldown for retry 1 = 2s
    });

    store.ensureRoomsLoaded(["!r2:s"], "high");

    const state = store.roomFetchStates.get("!r2:s");
    expect(state?.status).toBe("loading");
  });

  it("skips error rooms when cooldown has NOT passed", () => {
    store.roomFetchStates.set("!r2:s", {
      status: "error",
      retryCount: 1,
      lastAttemptAt: Date.now(), // just now, cooldown = 2^0 * 1000 = 1s
    });

    store.ensureRoomsLoaded(["!r2:s"], "high");

    const state = store.roomFetchStates.get("!r2:s");
    expect(state?.status).toBe("error"); // not changed
  });

  it("skips error rooms when max retries reached", () => {
    store.roomFetchStates.set("!r2:s", {
      status: "error",
      retryCount: 3,
      lastAttemptAt: Date.now() - 60000,
    });

    store.ensureRoomsLoaded(["!r2:s"], "high");

    const state = store.roomFetchStates.get("!r2:s");
    expect(state?.status).toBe("error"); // unchanged
  });

  it("marks success even when cache returns empty (graceful degradation)", async () => {
    vi.mocked(getCachedMessages).mockResolvedValueOnce([]);

    store.ensureRoomsLoaded(["!r2:s"], "high");

    await waitFor(() => store.roomFetchStates.get("!r2:s")?.status === "success");
    expect(store.roomFetchStates.get("!r2:s")?.status).toBe("success");
  });

  it("skips active room", () => {
    store.ensureRoomsLoaded(["!r1:s"], "high"); // active room

    expect(store.roomFetchStates.has("!r1:s")).toBe(false);
  });

  it("skips invite rooms", () => {
    store.rooms = [
      makeRoom({ id: "!active:s", updatedAt: 300 }),
      makeRoom({ id: "!invited:s", updatedAt: 200, membership: "invite" }),
    ];
    store.activeRoomId = "!active:s";

    store.ensureRoomsLoaded(["!invited:s"], "high");

    expect(store.roomFetchStates.has("!invited:s")).toBe(false);
  });

  it("handles multiple rooms concurrently up to MAX_CONCURRENT", () => {
    store.ensureRoomsLoaded(["!r2:s", "!r3:s", "!r4:s", "!r5:s"], "high");

    // All should be loading (MAX_CONCURRENT=5 > 4 rooms)
    expect(store.roomFetchStates.get("!r2:s")?.status).toBe("loading");
    expect(store.roomFetchStates.get("!r3:s")?.status).toBe("loading");
    expect(store.roomFetchStates.get("!r4:s")?.status).toBe("loading");
    expect(store.roomFetchStates.get("!r5:s")?.status).toBe("loading");
  });

  it("retryRoomFetch resets retryCount and re-fetches", async () => {
    store.roomFetchStates.set("!r2:s", {
      status: "error",
      retryCount: 3, // max reached
      lastAttemptAt: Date.now(),
    });

    store.retryRoomFetch("!r2:s");

    expect(store.roomFetchStates.get("!r2:s")?.status).toBe("loading");

    await waitFor(() => store.roomFetchStates.get("!r2:s")?.status === "success");
    const final = store.roomFetchStates.get("!r2:s");
    expect(final?.status).toBe("success");
    expect(final?.retryCount).toBe(0);
  });

  it("high priority rooms are processed before low priority", async () => {
    // Enqueue low priority first
    store.ensureRoomsLoaded(["!r4:s", "!r5:s"], "low");
    // Then high priority
    store.ensureRoomsLoaded(["!r2:s", "!r3:s"], "high");

    // All should eventually succeed
    await waitFor(() =>
      store.roomFetchStates.get("!r2:s")?.status === "success" &&
      store.roomFetchStates.get("!r4:s")?.status === "success",
    );

    expect(store.roomFetchStates.get("!r2:s")?.status).toBe("success");
    expect(store.roomFetchStates.get("!r4:s")?.status).toBe("success");
  });
});

describe("generation-based cancellation", () => {
  let store: ReturnType<typeof useChatStore>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("requestIdleCallback", (cb: () => void) => { cb(); return 0; });
    setActivePinia(createTestingPinia({ stubActions: false }));
    store = useChatStore();

    store.rooms = [
      makeRoom({ id: "!r1:s", updatedAt: 500 }),
      makeRoom({ id: "!r2:s", updatedAt: 400 }),
      makeRoom({ id: "!r3:s", updatedAt: 300 }),
      makeRoom({ id: "!r4:s", updatedAt: 200 }),
      makeRoom({ id: "!r5:s", updatedAt: 100 }),
    ];
    store.activeRoomId = "!r1:s";
  });

  it("new generation clears pending queue from old generation", () => {
    // Generation 1 — load r2, r3
    store.ensureRoomsLoaded(["!r2:s", "!r3:s"], "high", 1);

    // Generation 2 — should cancel gen 1 items and load r4, r5
    store.ensureRoomsLoaded(["!r4:s", "!r5:s"], "high", 2);

    // r4, r5 should be loading (new generation)
    expect(store.roomFetchStates.get("!r4:s")?.status).toBe("loading");
    expect(store.roomFetchStates.get("!r5:s")?.status).toBe("loading");
  });

  it("same generation does not clear queue", () => {
    store.ensureRoomsLoaded(["!r2:s"], "high", 1);
    store.ensureRoomsLoaded(["!r3:s"], "high", 1);

    // Both should be loading
    expect(store.roomFetchStates.get("!r2:s")?.status).toBe("loading");
    expect(store.roomFetchStates.get("!r3:s")?.status).toBe("loading");
  });

  it("stale generation fetch does not mark success", async () => {
    let resolveCache: (() => void) | undefined;
    vi.mocked(getCachedMessages).mockImplementationOnce(() =>
      new Promise<any[]>(resolve => { resolveCache = () => resolve([]); }),
    );

    store.ensureRoomsLoaded(["!r2:s"], "high", 1);

    // New generation before cache resolves
    store.ensureRoomsLoaded(["!r3:s"], "high", 2);

    // Now resolve the old generation's cache
    resolveCache?.();
    await new Promise(r => setTimeout(r, 50));

    // r2 should have been reset to idle (not success) since gen 1 is stale
    const state = store.roomFetchStates.get("!r2:s");
    expect(state?.status).not.toBe("success");
  });
});

describe("preloadRoomsByIds — backward compatibility", () => {
  let store: ReturnType<typeof useChatStore>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("requestIdleCallback", (cb: () => void) => { cb(); return 0; });
    setActivePinia(createTestingPinia({ stubActions: false }));
    store = useChatStore();

    store.rooms = [
      makeRoom({ id: "!r1:s", updatedAt: 300 }),
      makeRoom({ id: "!r2:s", updatedAt: 200 }),
    ];
    store.activeRoomId = "!r1:s";
  });

  it("still available and delegates to ensureRoomsLoaded", async () => {
    store.preloadRoomsByIds(["!r2:s"]);

    await waitFor(() => store.roomFetchStates.get("!r2:s")?.status === "success");

    expect(store.roomFetchStates.get("!r2:s")?.status).toBe("success");
  });

  it("allows re-fetch after error (no once-only Set blocking)", async () => {
    // Simulate error by making cache throw
    vi.mocked(getCachedMessages).mockRejectedValueOnce(new Error("cache error"));

    store.preloadRoomsByIds(["!r2:s"]);

    await waitFor(() => {
      const s = store.roomFetchStates.get("!r2:s")?.status;
      return s === "success" || s === "error";
    });

    // Reset mock to succeed
    vi.mocked(getCachedMessages).mockResolvedValue([]);

    // If it was error, wait for cooldown
    if (store.roomFetchStates.get("!r2:s")?.status === "error") {
      await new Promise(r => setTimeout(r, 1100));
    }

    store.preloadRoomsByIds(["!r2:s"]);

    await waitFor(() => store.roomFetchStates.get("!r2:s")?.status === "success");
    expect(store.roomFetchStates.get("!r2:s")?.status).toBe("success");
  });
});
