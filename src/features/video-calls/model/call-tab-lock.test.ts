import { describe, it, expect, vi, beforeEach } from "vitest";

const platform = { isNative: false };
vi.mock("@/shared/lib/platform", () => ({
  get isNative() {
    return platform.isNative;
  },
}));
vi.mock("@/entities/call", () => ({ useCallStore: () => ({ isInCall: false }) }));

describe("call tab lock", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useRealTimers();
  });

  // Regression: on Android/iOS every dial and incoming call waited the full
  // second for a tab that cannot exist.
  it("answers at once on native", async () => {
    platform.isNative = true;
    const lock = await import("./call-tab-lock");
    lock.initCallTabLock();
    const t0 = Date.now();
    await expect(lock.checkOtherTabHasCall()).resolves.toBe(false);
    expect(Date.now() - t0).toBeLessThan(100);
    lock.destroyCallTabLock();
  });

  it("still asks the other tabs on the web", async () => {
    platform.isNative = false;
    vi.useFakeTimers();
    const lock = await import("./call-tab-lock");
    lock.initCallTabLock();
    let settled = false;
    const pending = lock.checkOtherTabHasCall().then((v) => {
      settled = true;
      return v;
    });
    await vi.advanceTimersByTimeAsync(500);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(600);
    await expect(pending).resolves.toBe(false);
    lock.destroyCallTabLock();
  });
});
