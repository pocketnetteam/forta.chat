import { describe, it, expect, beforeEach, vi } from "vitest";
import { setActivePinia } from "pinia";
import { createTestingPinia } from "@pinia/testing";

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

/**
 * Regression: a Dexie open/read failure (corrupted IndexedDB, quota
 * exceeded, WebView storage wiped mid-session) on the very first local-DB
 * read used to be an unhandled promise rejection inside the
 * `watch(chatDbKitRef, ...)` callback — dexieRoomsReady stayed false
 * forever with no logged cause, and the failure was invisible. The existing
 * degraded-state watchdog (startInitialSyncWatch) still unblocks the loading
 * UI on its own independent timer regardless of this, but the underlying
 * cause was silent. Now the failure is caught and logged instead of left as
 * an unhandled rejection.
 */
describe("chat-store — initDexieRooms failure is caught, not an unhandled rejection", () => {
  let store: ReturnType<typeof useChatStore>;

  beforeEach(() => {
    setActivePinia(createTestingPinia({ stubActions: false }));
    store = useChatStore();
    vi.clearAllMocks();
  });

  it("logs the failure and leaves dexieRoomsReady false instead of throwing/hanging", async () => {
    const dbError = new Error("IndexedDB open failed: VersionError");
    const kit = {
      rooms: {
        getAllRooms: vi.fn(async () => {
          throw dbError;
        }),
        observeRoomChanges: vi.fn(() => () => {}),
      },
      eventWriter: { enableBatching: vi.fn(), setClearedAtTs: vi.fn() },
    };

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    // setChatDbKit triggers the `watch(chatDbKitRef, ...)` callback that
    // calls initDexieRooms — must not throw synchronously or leave an
    // unhandled rejection.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => store.setChatDbKit(kit as any)).not.toThrow();

    // Let the async watcher callback run and reject.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("initDexieRooms failed"),
      dbError,
    );
    // Not silently marked ready — downstream consumers must keep treating
    // the local DB as unavailable rather than rendering an empty-but-"ready" list.
    expect(store.dexieRoomsReady).toBe(false);

    errorSpy.mockRestore();
  });
});
