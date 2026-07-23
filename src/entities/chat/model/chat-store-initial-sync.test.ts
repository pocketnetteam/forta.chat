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
import { makeRoom } from "@/test-utils";

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
import { isChatsInteractive, __resetBootSignalsForTests } from "@/shared/lib/boot-signals";

describe("chat-store WEE-55 initial-sync watchdog", () => {
  let store: ReturnType<typeof useChatStore>;

  beforeEach(() => {
    __resetBootSignalsForTests();
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

  // WEE-97: deferred boot work (recovery scans, Tor, telemetry) is released
  // by the chats-interactive signal — it must fire on BOTH paths that flip
  // roomsInitialized, or the deferred work waits for the 15-30s fallbacks.
  it("WEE-97: signals chats-interactive when the first PREPARED refresh lands", () => {
    expect(isChatsInteractive()).toBe(false);
    store.setHelpers(mockMatrixService.kit as never, {} as never);
    store.refreshRooms("PREPARED");
    vi.advanceTimersByTime(150);
    expect(isChatsInteractive()).toBe(true);
  });

  it("WEE-97: signals chats-interactive on watchdog degrade too", () => {
    expect(isChatsInteractive()).toBe(false);
    store.startInitialSyncWatch();
    vi.advanceTimersByTime(8000);
    expect(isChatsInteractive()).toBe(true);
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

describe("chat-store room-list first-load states", () => {
  let store: ReturnType<typeof useChatStore>;

  beforeEach(() => {
    __resetBootSignalsForTests();
    vi.useFakeTimers();
    setActivePinia(createTestingPinia({ stubActions: false }));
    store = useChatStore();
    // getRooms() returns [] for the whole suite → sortedRooms stays empty.
    mockMatrixService.getRooms.mockReturnValue([]);
  });

  afterEach(() => {
    store.cleanup();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("is 'loading' before the watchdog: skeleton on, not slow, not empty", () => {
    store.startInitialSyncWatch();
    expect(store.isRoomListLoading).toBe(true);
    expect(store.isRoomListLoadingSlow).toBe(false);
    expect(store.isRoomListAuthoritativeEmpty).toBe(false);
  });

  it("switches to slow placeholder after the 8s degrade (still not empty)", () => {
    store.startInitialSyncWatch();
    vi.advanceTimersByTime(8000);
    expect(store.initialSyncStatus).toBe("degraded");
    expect(store.isRoomListLoading).toBe(true);
    expect(store.isRoomListLoadingSlow).toBe(true);
    // Must NOT flash the "no dialogs" empty state on degrade.
    expect(store.isRoomListAuthoritativeEmpty).toBe(false);
  });

  it("accepts authoritative empty after degraded escape window", () => {
    store.startInitialSyncWatch();
    vi.advanceTimersByTime(8000);
    expect(store.isRoomListLoadingSlow).toBe(true);
    expect(store.isRoomListAuthoritativeEmpty).toBe(false);

    // DEGRADED_EMPTY_ESCAPE_MS = 8000
    vi.advanceTimersByTime(8000);

    expect(store.isRoomListAuthoritativeEmpty).toBe(true);
    expect(store.isRoomListLoading).toBe(false);
    expect(store.isRoomListLoadingSlow).toBe(false);
  });

  it("does NOT show authoritative empty at PREPARED with an empty snapshot", () => {
    store.setHelpers(mockMatrixService.kit as never, {} as never);
    store.refreshRooms("PREPARED");
    vi.advanceTimersByTime(150); // debounce → refreshRoomsImmediate

    expect(store.initialSyncStatus).toBe("ready");
    expect(store.syncState).toBe("PREPARED");
    // Rooms may not be materialized at PREPARED → keep the skeleton, no empty.
    expect(store.isRoomListAuthoritativeEmpty).toBe(false);
    expect(store.isRoomListLoading).toBe(true);
    expect(store.isRoomListLoadingSlow).toBe(false);
  });

  it("accepts authoritative empty after PREPARED empty grace", () => {
    store.setHelpers(mockMatrixService.kit as never, {} as never);
    store.refreshRooms("PREPARED");
    vi.advanceTimersByTime(150);

    expect(store.isRoomListAuthoritativeEmpty).toBe(false);
    expect(store.isRoomListLoading).toBe(true);

    // PREPARED_EMPTY_GRACE_MS = 3000
    vi.advanceTimersByTime(3000);

    expect(store.syncState).toBe("PREPARED");
    expect(store.isRoomListAuthoritativeEmpty).toBe(true);
    expect(store.isRoomListLoading).toBe(false);
  });

  it("shows authoritative empty only once sync reaches steady-state SYNCING", () => {
    store.setHelpers(mockMatrixService.kit as never, {} as never);
    store.refreshRooms("PREPARED");
    vi.advanceTimersByTime(150);
    expect(store.isRoomListAuthoritativeEmpty).toBe(false);

    store.refreshRooms("SYNCING");
    vi.advanceTimersByTime(150);

    expect(store.initialSyncStatus).toBe("ready");
    expect(store.syncState).toBe("SYNCING");
    expect(store.isRoomListAuthoritativeEmpty).toBe(true);
    expect(store.isRoomListLoading).toBe(false);
    expect(store.isRoomListLoadingSlow).toBe(false);
  });

  it("cancels PREPARED empty escape when rooms appear before grace elapses", () => {
    store.setHelpers(mockMatrixService.kit as never, {} as never);
    store.refreshRooms("PREPARED");
    vi.advanceTimersByTime(150);
    expect(store.isRoomListLoading).toBe(true);

    // rooms is a shallowRef — pin change forces sortedRooms recompute after addRoom.
    store.addRoom(makeRoom({ id: "!r1:s" }));
    store.togglePinRoom("!r1:s");
    expect(store.sortedRooms.length).toBeGreaterThan(0);
    expect(store.isRoomListLoading).toBe(false);
    expect(store.isRoomListAuthoritativeEmpty).toBe(false);

    // Grace would have fired — must NOT flip to empty now that rooms exist.
    vi.advanceTimersByTime(3000);
    expect(store.isRoomListAuthoritativeEmpty).toBe(false);
    expect(store.sortedRooms.length).toBeGreaterThan(0);
  });
});
