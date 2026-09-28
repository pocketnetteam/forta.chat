import { describe, it, expect, vi, afterEach } from "vitest";
import { effectScope, ref } from "vue";

vi.mock("@/shared/lib/connectivity", () => ({
  useConnectivity: () => ({ isOnline: ref(true) }),
}));
vi.mock("@/shared/lib/i18n", () => ({
  useI18n: () => ({ t: (k: string) => k }),
}));

/**
 * Audit W2D-01: the shared debounced status was created inside the first
 * caller's component, so when ChatSidebar was remounted (desktop ↔ mobile
 * width) its watcher died and the connection header froze for the session.
 */
describe("useSyncStatus after its first user unmounts", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
  });

  it("keeps following the sync state in the next component", async () => {
    vi.useFakeTimers();
    vi.resetModules();
    const { useSyncStatus, resetSyncStatus, handleSdkSync } = await import("./use-sync-status");
    resetSyncStatus();

    const first = effectScope();
    first.run(() => useSyncStatus());
    first.stop(); // the sidebar unmounts

    const second = effectScope();
    const status = second.run(() => useSyncStatus())!;
    handleSdkSync("ERROR");
    await vi.advanceTimersByTimeAsync(5_000);

    expect(status.displayStatus.value).toBe("error");
    second.stop();
    resetSyncStatus();
  });
});
