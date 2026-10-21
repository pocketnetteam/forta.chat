// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { nextTick, ref } from "vue";

// Keep the composable isolated from real connectivity / i18n side effects.
vi.mock("@/shared/lib/connectivity", () => ({
  useConnectivity: () => ({ isOnline: ref(true) }),
}));
vi.mock("@/shared/lib/i18n", () => ({
  useI18n: () => ({ t: (k: string) => k }),
}));

import { checkSyncFreshness, handleSdkSync, resetSyncStatus, useSyncStatus } from "./use-sync-status";

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

  // Audit S3b-02: the cap used to turn a still-failing sync into "up to date"
  // after a minute — e.g. after the homeserver rejected the token and the SDK
  // stopped syncing for good. An error now stays until a real sync clears it.
  it("ошибка остаётся ошибкой до настоящей синхронизации, повторные ERROR не продлевают таймер", () => {
    const { rawStatus } = useSyncStatus();

    handleSdkSync("ERROR"); // arms ERROR_STALE_TIMEOUT at t=0
    expect(rawStatus.value).toBe("error");

    vi.advanceTimersByTime(ERROR_STALE_TIMEOUT - 10_000); // t=50s
    handleSdkSync("ERROR"); // must NOT push the deadline out
    expect(rawStatus.value).toBe("error");

    vi.advanceTimersByTime(ERROR_STALE_TIMEOUT * 5);
    expect(rawStatus.value).toBe("error");

    handleSdkSync("PREPARED"); // the next real sync
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

describe("use-sync-status — routine SYNCING does not spin the header", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetSyncStatus();
  });

  afterEach(() => {
    resetSyncStatus();
    vi.useRealTimers();
  });

  it("SYNCING через 30с после PREPARED (обычный long-poll) — это syncing, не catching_up", async () => {
    const { rawStatus, displayStatus } = useSyncStatus();

    handleSdkSync("PREPARED");
    await nextTick();
    vi.advanceTimersByTime(STALE_TIMEOUT);

    handleSdkSync("SYNCING");
    await nextTick();
    expect(rawStatus.value).toBe("syncing");

    // Past the 1.5s show delay of an active phase: nothing must surface.
    vi.advanceTimersByTime(5_000);
    expect(displayStatus.value).not.toBe("catching_up");
    expect(displayStatus.value).not.toBe("connecting");
  });

  it("SYNCING после RECONNECTING гасит статус и снимает stale-таймер", () => {
    const { rawStatus } = useSyncStatus();

    handleSdkSync("PREPARED");
    handleSdkSync("RECONNECTING");
    expect(rawStatus.value).toBe("connecting");

    handleSdkSync("SYNCING");
    expect(rawStatus.value).toBe("syncing");

    // The stale timer was cleared — it must not flip the state later.
    vi.advanceTimersByTime(STALE_TIMEOUT * 2);
    expect(rawStatus.value).toBe("syncing");
  });
});

describe("use-sync-status — catch-up indicator after a stale last sync", () => {
  const LAST_SYNC_KEY = "forta.sync.lastSuccessAt";
  const FRESHNESS_THRESHOLD = 2 * 60_000;

  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    resetSyncStatus();
  });

  afterEach(() => {
    resetSyncStatus();
    localStorage.clear();
    vi.useRealTimers();
  });

  it("PREPARED из кэша при последнем синке > 2 мин назад → catching_up до первого SYNCING", async () => {
    const { rawStatus, displayStatus } = useSyncStatus();
    localStorage.setItem(LAST_SYNC_KEY, String(Date.now() - FRESHNESS_THRESHOLD - 1));

    handleSdkSync("PREPARED", { fromCache: true });
    await nextTick();
    expect(rawStatus.value).toBe("catching_up");

    vi.advanceTimersByTime(2_000); // past the 1.5s show delay
    expect(displayStatus.value).toBe("catching_up");

    handleSdkSync("SYNCING");
    expect(rawStatus.value).toBe("syncing");
    expect(Number(localStorage.getItem(LAST_SYNC_KEY))).toBe(Date.now());
  });

  it("PREPARED из кэша держит спиннер до первого живого синка, даже если прошлый синк свежий", () => {
    const { rawStatus } = useSyncStatus();
    localStorage.setItem(LAST_SYNC_KEY, String(Date.now() - 30_000));

    handleSdkSync("PREPARED", { fromCache: true });
    expect(rawStatus.value).toBe("catching_up");

    handleSdkSync("SYNCING");
    expect(rawStatus.value).toBe("syncing");
  });

  it("живой PREPARED (без кэша SDK) сразу гасит спиннер и записывает время синка", () => {
    const { rawStatus } = useSyncStatus();

    handleSdkSync("PREPARED", { fromCache: false });
    expect(rawStatus.value).toBe("up_to_date");
    expect(Number(localStorage.getItem(LAST_SYNC_KEY))).toBe(Date.now());
  });

  it("спиннер показывается с самого старта страницы, ещё до PREPARED", () => {
    const { displayStatus } = useSyncStatus();
    vi.advanceTimersByTime(2_000); // past the 1.5s show delay
    expect(displayStatus.value).toBe("connecting");
  });

  it("свежий последний синк → PREPARED сразу up_to_date", () => {
    const { rawStatus } = useSyncStatus();
    localStorage.setItem(LAST_SYNC_KEY, String(Date.now() - 30_000));

    handleSdkSync("PREPARED");
    expect(rawStatus.value).toBe("up_to_date");
  });

  it("первый запуск без сохранённого синка не показывает индикатор", () => {
    const { rawStatus } = useSyncStatus();

    handleSdkSync("PREPARED");
    expect(rawStatus.value).toBe("up_to_date");
  });

  it("возврат в приложение после паузы > 2 мин включает catching_up", () => {
    const { rawStatus } = useSyncStatus();
    handleSdkSync("SYNCING"); // records now

    vi.advanceTimersByTime(FRESHNESS_THRESHOLD - 1_000);
    checkSyncFreshness();
    expect(rawStatus.value).toBe("syncing");

    vi.advanceTimersByTime(2_000);
    checkSyncFreshness();
    expect(rawStatus.value).toBe("catching_up");
  });

  it("не перебивает error и гасится stale-таймером, если синк завис", () => {
    const { rawStatus } = useSyncStatus();
    localStorage.setItem(LAST_SYNC_KEY, String(Date.now() - FRESHNESS_THRESHOLD - 1));

    handleSdkSync("ERROR");
    checkSyncFreshness();
    expect(rawStatus.value).toBe("error");

    handleSdkSync("PREPARED", { fromCache: true });
    expect(rawStatus.value).toBe("catching_up");
    vi.advanceTimersByTime(2 * 60_000);
    expect(rawStatus.value).toBe("up_to_date");
  });
});

describe("use-sync-status — boot spinner until the first live /sync", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    localStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows the spinner on a fast reload (cache PREPARED → live SYNCING within a second)", async () => {
    const mod = await import("./use-sync-status");
    const { displayStatus } = mod.useSyncStatus();
    const seen: string[] = [];
    const { watch } = await import("vue");
    watch(displayStatus, (s) => seen.push(s), { immediate: true, flush: "sync" });

    vi.advanceTimersByTime(300);
    mod.handleSdkSync("PREPARED", { fromCache: true });
    await nextTick();
    vi.advanceTimersByTime(300);
    mod.handleSdkSync("SYNCING");
    await nextTick();
    vi.advanceTimersByTime(2_000);

    expect(seen.some((s) => s === "connecting" || s === "catching_up")).toBe(true);
    expect(displayStatus.value).toBe("idle");
  });
});
