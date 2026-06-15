import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ref } from "vue";

// Keep the composable isolated from real connectivity / i18n side effects.
vi.mock("@/shared/lib/connectivity", () => ({
  useConnectivity: () => ({ isOnline: ref(true) }),
}));
vi.mock("@/shared/lib/i18n", () => ({
  useI18n: () => ({ t: (k: string) => k }),
}));

import { handleSdkSync, resetSyncStatus, useSyncStatus } from "./use-sync-status";

const ERROR_STALE_TIMEOUT = 60_000;
const STALE_TIMEOUT = 30_000;

describe("use-sync-status — bounded reconnect banner (WEE-105 H4)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetSyncStatus();
  });

  afterEach(() => {
    resetSyncStatus();
    vi.useRealTimers();
  });

  it("stale-таймер ERROR анкорится к ПЕРВОЙ ошибке и не продлевается на повторных", () => {
    const { rawStatus } = useSyncStatus();

    handleSdkSync("ERROR"); // arms ERROR_STALE_TIMEOUT at t=0
    expect(rawStatus.value).toBe("error");

    vi.advanceTimersByTime(ERROR_STALE_TIMEOUT - 10_000); // t=50s
    handleSdkSync("ERROR"); // must NOT push the deadline out
    expect(rawStatus.value).toBe("error");

    vi.advanceTimersByTime(10_000); // t=60s from the first error → cap fires
    expect(rawStatus.value).toBe("up_to_date");
  });

  it("RECONNECTING-шторм не держит баннер вечно (anchor к первой)", () => {
    const { rawStatus } = useSyncStatus();

    handleSdkSync("RECONNECTING"); // arms STALE_TIMEOUT at t=0
    expect(rawStatus.value).toBe("connecting");

    // Reconnects arriving faster than the timeout used to re-arm it forever —
    // now they are ignored (deadline stays anchored to the first one).
    vi.advanceTimersByTime(10_000);
    handleSdkSync("RECONNECTING"); // t=10s, no re-arm
    vi.advanceTimersByTime(10_000);
    handleSdkSync("RECONNECTING"); // t=20s, no re-arm

    vi.advanceTimersByTime(STALE_TIMEOUT - 20_000); // t=30s → anchored cap fires
    expect(rawStatus.value).toBe("up_to_date");
  });

  it("PREPARED гасит баннер и снимает stale-таймер (восстановление после failover)", () => {
    const { rawStatus } = useSyncStatus();

    handleSdkSync("ERROR");
    expect(rawStatus.value).toBe("error");

    handleSdkSync("PREPARED");
    expect(rawStatus.value).toBe("up_to_date");

    // Timer was cleared — no later flip surprises.
    vi.advanceTimersByTime(ERROR_STALE_TIMEOUT * 2);
    expect(rawStatus.value).toBe("up_to_date");
  });
});
