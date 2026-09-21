import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ref } from "vue";

// Keep the composable isolated from real connectivity / i18n side effects.
const isOnline = ref(true);
vi.mock("@/shared/lib/connectivity", () => ({
  useConnectivity: () => ({ isOnline }),
}));
vi.mock("@/shared/lib/i18n", () => ({
  useI18n: () => ({ t: (k: string) => k }),
}));

import { nextTick } from "vue";
import { handleSdkSync, resetSyncStatus, useSyncStatus } from "./use-sync-status";

const STALE_TIMEOUT = 30_000;

describe("use-sync-status — bounded spinner, truthful state", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    isOnline.value = true;
    resetSyncStatus();
  });

  afterEach(() => {
    resetSyncStatus();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("регрессия: ERROR не превращается в «up_to_date» по таймеру — мёртвый /sync остаётся видимым", () => {
    const { rawStatus } = useSyncStatus();

    handleSdkSync("ERROR");
    expect(rawStatus.value).toBe("error");

    // Old cap flipped this to "up_to_date" after 60s while no messages arrived.
    vi.advanceTimersByTime(10 * 60_000);
    expect(rawStatus.value).toBe("error");
  });

  it("RECONNECTING-шторм: спиннер ограничен, по истечении окна — error (anchor к первой)", () => {
    const { rawStatus } = useSyncStatus();

    handleSdkSync("RECONNECTING"); // arms STALE_TIMEOUT at t=0
    expect(rawStatus.value).toBe("connecting");

    // Reconnects arriving faster than the timeout must not push the deadline out.
    vi.advanceTimersByTime(10_000);
    handleSdkSync("RECONNECTING"); // t=10s, no re-arm
    vi.advanceTimersByTime(10_000);
    handleSdkSync("RECONNECTING"); // t=20s, no re-arm

    vi.advanceTimersByTime(STALE_TIMEOUT - 20_000); // t=30s → anchored cap fires
    expect(rawStatus.value).toBe("error");
  });

  it("ERROR↔RECONNECTING флаппинг заканчивается в error, а не в up_to_date", () => {
    const { rawStatus } = useSyncStatus();

    handleSdkSync("ERROR");
    handleSdkSync("RECONNECTING"); // arms the cap
    vi.advanceTimersByTime(15_000);
    handleSdkSync("ERROR");
    handleSdkSync("RECONNECTING");
    vi.advanceTimersByTime(STALE_TIMEOUT);

    expect(rawStatus.value).toBe("error");
  });

  it("долгий catch-up (здоровый SYNCING) по таймеру гасится в up_to_date", () => {
    const { rawStatus } = useSyncStatus();

    vi.advanceTimersByTime(10_000); // gap since lastUpToDateAt(0) > RECONNECT_THRESHOLD
    handleSdkSync("SYNCING");
    expect(rawStatus.value).toBe("catching_up");

    vi.advanceTimersByTime(STALE_TIMEOUT);
    expect(rawStatus.value).toBe("up_to_date");
  });

  it("PREPARED гасит error и снимает stale-таймер (восстановление после failover)", () => {
    const { rawStatus } = useSyncStatus();

    handleSdkSync("RECONNECTING");
    handleSdkSync("ERROR");
    expect(rawStatus.value).toBe("error");

    handleSdkSync("PREPARED");
    expect(rawStatus.value).toBe("up_to_date");

    // Timer was cleared — no later flip surprises.
    vi.advanceTimersByTime(STALE_TIMEOUT * 4);
    expect(rawStatus.value).toBe("up_to_date");
  });

  it("SYNCING после длительной ошибки выводит из error", () => {
    const { rawStatus } = useSyncStatus();

    handleSdkSync("ERROR");
    vi.advanceTimersByTime(5 * 60_000);
    handleSdkSync("SYNCING");

    expect(rawStatus.value).not.toBe("error");
  });

  it("offline не маскируется в up_to_date по таймеру", () => {
    vi.stubGlobal("navigator", { onLine: false });
    const { rawStatus } = useSyncStatus();

    handleSdkSync("ERROR");
    expect(rawStatus.value).toBe("offline");

    vi.advanceTimersByTime(10 * 60_000);
    expect(rawStatus.value).toBe("offline");
  });

  it("возврат сети: connecting ограничен окном и без healthy sync переходит в error", async () => {
    const { rawStatus } = useSyncStatus();

    isOnline.value = false;
    await nextTick();
    expect(rawStatus.value).toBe("offline");

    isOnline.value = true;
    await nextTick();
    expect(rawStatus.value).toBe("connecting");

    vi.advanceTimersByTime(STALE_TIMEOUT);
    expect(rawStatus.value).toBe("error");
  });
});
