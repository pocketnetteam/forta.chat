/**
 * WEE-55 — post-update Matrix sync hang regression tests.
 *
 * Guards the initial-sync lifecycle watchdog: if the first /sync never lands
 * (invalid sync_token, slow 3G, server stall) the UI must stop showing an
 * infinite preloader and degrade to the cached/empty state instead.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { setActivePinia } from "pinia";
import { createTestingPinia } from "@pinia/testing";

const mockMatrixService = {
  isReady: vi.fn(() => true),
  getUserId: vi.fn(() => "@me:server"),
  getRooms: vi.fn(() => [] as unknown[]),
  getRoom: vi.fn(() => ({ selfMembership: "join" })),
  getIgnoredMatrixUserIds: vi.fn(() => [] as string[]),
  kit: { client: { getUserId: () => "@me:server" } },
};

vi.mock("@/entities/matrix", () => ({
  getMatrixClientService: vi.fn(() => mockMatrixService),
}));

import { useChatStore } from "./chat-store";

describe("chat-store WEE-55 initial-sync watchdog", () => {
  let store: ReturnType<typeof useChatStore>;

  beforeEach(() => {
    vi.useFakeTimers();
    setActivePinia(createTestingPinia({ stubActions: false }));
    store = useChatStore();
  });

  afterEach(() => {
    store.cleanup();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("starts in 'loading' with isSyncing true", () => {
    expect(store.initialSyncStatus).toBe("loading");
    expect(store.isSyncing).toBe(true);
    expect(store.roomsInitialized).toBe(false);
  });

  it("degrades after the timeout when the first sync never completes", () => {
    store.startInitialSyncWatch();
    expect(store.initialSyncStatus).toBe("loading");

    vi.advanceTimersByTime(8000);

    // Stop blocking the UI: surface cached rooms / empty hint, not a spinner.
    expect(store.initialSyncStatus).toBe("degraded");
    expect(store.roomsInitialized).toBe(true);
    expect(store.isSyncing).toBe(false);
  });

  it("does not degrade before the deadline elapses", () => {
    store.startInitialSyncWatch();
    vi.advanceTimersByTime(7999);
    expect(store.initialSyncStatus).toBe("loading");
    expect(store.isSyncing).toBe(true);
  });

  it("reaches 'ready' on a PREPARED sync and cancels the degraded fallback", () => {
    // setHelpers wires the Matrix client and arms the watchdog.
    store.setHelpers(mockMatrixService.kit as never, {} as never);
    expect(store.initialSyncStatus).toBe("loading");

    store.refreshRooms("PREPARED");
    vi.advanceTimersByTime(150); // debounce window → refreshRoomsImmediate

    expect(store.roomsInitialized).toBe(true);
    expect(store.initialSyncStatus).toBe("ready");
    expect(store.isSyncing).toBe(false);

    // The watchdog must have been cleared — staying ready past the deadline.
    vi.advanceTimersByTime(8000);
    expect(store.initialSyncStatus).toBe("ready");
  });

  // WEE-80 (forta-bugs#956): supersedes the original WEE-55 expectation that a
  // lost connection re-raised isSyncing. The local-first read path must NOT
  // depend on the network — once the first sync (or the watchdog degrade) has
  // settled, the in-room message skeleton (isSyncing) stays down so cached
  // Dexie content keeps rendering. Connection status is exposed separately via
  // `syncState` (and the sync banner), not via isSyncing.
  it("does NOT re-raise isSyncing when the connection drops after ready (WEE-80)", () => {
    store.setHelpers(mockMatrixService.kit as never, {} as never);
    store.refreshRooms("PREPARED");
    vi.advanceTimersByTime(150);
    expect(store.isSyncing).toBe(false);

    store.setSyncState("RECONNECTING");
    expect(store.isSyncing).toBe(false);
    expect(store.syncState).toBe("RECONNECTING"); // connection state still observable

    store.setSyncState("ERROR");
    expect(store.isSyncing).toBe(false);
  });

  it("upgrades degraded → ready when a real PREPARED sync arrives late", () => {
    // Simulate the post-update hang: watchdog armed, sync never lands in time.
    store.setHelpers(mockMatrixService.kit as never, {} as never);
    vi.advanceTimersByTime(8000);
    expect(store.initialSyncStatus).toBe("degraded");
    expect(store.roomsInitialized).toBe(true);
    expect(store.isSyncing).toBe(false);

    // The stalled /sync finally completes → first PREPARED arrives.
    store.refreshRooms("PREPARED");
    vi.advanceTimersByTime(150); // debounce → refreshRoomsImmediate

    // Status upgrades to ready; roomsInitialized stays true (no flicker back).
    expect(store.initialSyncStatus).toBe("ready");
    expect(store.roomsInitialized).toBe(true);
    expect(store.isSyncing).toBe(false);
  });

  it("cleanup resets the lifecycle back to 'loading'", () => {
    store.startInitialSyncWatch();
    vi.advanceTimersByTime(8000);
    expect(store.initialSyncStatus).toBe("degraded");

    store.cleanup();
    expect(store.initialSyncStatus).toBe("loading");
    expect(store.roomsInitialized).toBe(false);

    // A fresh watchdog can be armed again after cleanup.
    store.startInitialSyncWatch();
    vi.advanceTimersByTime(8000);
    expect(store.initialSyncStatus).toBe("degraded");
  });
});
