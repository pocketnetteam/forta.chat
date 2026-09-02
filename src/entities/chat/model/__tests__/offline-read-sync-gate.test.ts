import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { setActivePinia } from "pinia";
import { createTestingPinia } from "@pinia/testing";
import type { LocalRoom } from "@/shared/lib/local-db";

// Matrix client reports NOT ready — emulates a cold-start in airplane mode
// where the SDK never connects.
const mockMatrixService = {
  getUserId: vi.fn(() => "@me:server"),
  getRoom: vi.fn(() => undefined),
  isReady: vi.fn(() => false),
  getIgnoredMatrixUserIds: vi.fn(() => [] as string[]),
  matrixId: vi.fn((id: string) => id),
};
vi.mock("@/entities/matrix", () => ({
  getMatrixClientService: vi.fn(() => mockMatrixService),
}));

import { useChatStore } from "../chat-store";
import { DEFAULT_WATCHDOG_CONFIG } from "@/entities/matrix/model/sync-failover";

const INITIAL_SYNC_TIMEOUT_MS = DEFAULT_WATCHDOG_CONFIG.staleTimeoutMs;

function makeLocalRoom(id: string, overrides: Partial<LocalRoom> = {}): LocalRoom {
  return {
    id,
    name: "Room",
    isGroup: false,
    members: ["@me:server", "@peer:server"],
    membership: "join",
    unreadCount: 0,
    lastReadInboundTs: 0,
    lastReadOutboundTs: 0,
    updatedAt: Date.now(),
    syncedAt: Date.now(),
    hasMoreHistory: true,
    isDeleted: false,
    deletedAt: null,
    deleteReason: null,
    ...overrides,
  };
}

function makeKit(rooms: LocalRoom[]) {
  return {
    rooms: {
      getAllRooms: vi.fn(async () => rooms),
      observeRoomChanges: vi.fn(() => () => {}),
      bulkSyncRooms: vi.fn(async () => {}),
    },
    eventWriter: { enableBatching: vi.fn(), setClearedAtTs: vi.fn() },
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("WEE-80 — chat-store offline read path (no Matrix, no network)", () => {
  let store: ReturnType<typeof useChatStore>;

  beforeEach(() => {
    setActivePinia(createTestingPinia({ stubActions: false }));
    store = useChatStore();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("A1: hydrates sortedRooms from Dexie even though Matrix is not ready", async () => {
    const kit = makeKit([
      makeLocalRoom("!a:s", { name: "Alice", lastMessageTimestamp: 2000 }),
      makeLocalRoom("!b:s", { name: "Bob", lastMessageTimestamp: 1000 }),
    ]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    store.setChatDbKit(kit as any);
    await flush();
    await flush();

    expect(mockMatrixService.isReady()).toBe(false);
    const ids = store.sortedRooms.map((r) => r.id);
    expect(ids).toContain("!a:s");
    expect(ids).toContain("!b:s");
    // Newest conversation sorts first — list is usable offline.
    expect(ids[0]).toBe("!a:s");
  });

  it("read-path skeleton (isSyncing) does NOT latch on a lost connection", () => {
    vi.useFakeTimers();

    // Wire helpers → starts the WEE-55 initial-sync watchdog.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    store.setHelpers({} as any, {} as any);

    // Genuine first-load phase: skeleton allowed.
    expect(store.isSyncing).toBe(true);

    // Watchdog gives up after INITIAL_SYNC_TIMEOUT_MS with no sync → degraded.
    // Cached Dexie data is now authoritative, so the read path must stop
    // reporting "syncing".
    vi.advanceTimersByTime(INITIAL_SYNC_TIMEOUT_MS);
    expect(store.isSyncing).toBe(false);

    // A failing/recovering Matrix poll (offline) must NOT re-raise the
    // read-path skeleton — connection status is surfaced elsewhere (WEE-80).
    store.setSyncState("ERROR");
    expect(store.isSyncing).toBe(false);
    store.setSyncState("RECONNECTING");
    expect(store.isSyncing).toBe(false);
  });
});
