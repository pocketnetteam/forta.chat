import { describe, it, expect, vi, afterEach } from "vitest";

const native = vi.hoisted(() => ({
  enabled: false,
  appListener: null as null | ((state: { isActive: boolean }) => void),
  remove: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/shared/lib/platform", () => ({
  get isNative() {
    return native.enabled;
  },
}));

vi.mock("@capacitor/app", () => ({
  App: {
    addListener: vi.fn((_event: string, cb: (state: { isActive: boolean }) => void) => {
      native.appListener = cb;
      return Promise.resolve({ remove: native.remove });
    }),
  },
}));

import { armMatrixReconnect, matrixRetryDelayMs, onForeground } from "./matrix-reconnect";

describe("matrixRetryDelayMs (audit S2-01)", () => {
  it("backs off from 15 s and doubles up to a 5-minute ceiling", () => {
    expect([1, 2, 3, 4, 5, 6, 12].map(matrixRetryDelayMs)).toEqual([
      15_000, 30_000, 60_000, 120_000, 240_000, 300_000, 300_000,
    ]);
  });

  it("treats a zero or negative count as the first failure", () => {
    expect(matrixRetryDelayMs(0)).toBe(15_000);
    expect(matrixRetryDelayMs(-3)).toBe(15_000);
  });
});

function sources() {
  const net = new Set<(change: { connected: boolean }) => void>();
  const foreground = new Set<() => void>();
  return {
    net,
    foreground,
    triggers: {
      onConnectivityChange: (cb: (change: { connected: boolean }) => void) => {
        net.add(cb);
        return () => net.delete(cb);
      },
      onForeground: (cb: () => void) => {
        foreground.add(cb);
        return () => foreground.delete(cb);
      },
    },
    goOnline: () => net.forEach((cb) => cb({ connected: true })),
    goOffline: () => net.forEach((cb) => cb({ connected: false })),
    comeBack: () => foreground.forEach((cb) => cb()),
  };
}

afterEach(() => {
  vi.useRealTimers();
  native.enabled = false;
  native.appListener = null;
  native.remove.mockClear();
});

describe("armMatrixReconnect", () => {
  it("retries when the network comes back", () => {
    const s = sources();
    const retry = vi.fn();
    armMatrixReconnect(s.triggers, { canRetry: () => true, retry });
    s.goOnline();
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("does not retry when the network goes away", () => {
    const s = sources();
    const retry = vi.fn();
    armMatrixReconnect(s.triggers, { canRetry: () => true, retry });
    s.goOffline();
    expect(retry).not.toHaveBeenCalled();
  });

  it("retries when the app comes back to the foreground", () => {
    const s = sources();
    const retry = vi.fn();
    armMatrixReconnect(s.triggers, { canRetry: () => true, retry });
    s.comeBack();
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("skips a trigger while a retry is not allowed", () => {
    const s = sources();
    const retry = vi.fn();
    let allowed = false;
    armMatrixReconnect(s.triggers, { canRetry: () => allowed, retry });
    s.goOnline();
    s.comeBack();
    expect(retry).not.toHaveBeenCalled();
    allowed = true;
    s.goOnline();
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("does not retry on its own without retryAfterMs", () => {
    vi.useFakeTimers();
    const s = sources();
    const retry = vi.fn();
    armMatrixReconnect(s.triggers, { canRetry: () => true, retry });
    vi.advanceTimersByTime(600_000);
    expect(retry).not.toHaveBeenCalled();
  });

  it("retries once after retryAfterMs when the network came back during the failed start", () => {
    vi.useFakeTimers();
    const s = sources();
    const retry = vi.fn();
    armMatrixReconnect(s.triggers, { canRetry: () => true, retry, retryAfterMs: 2_000 });
    vi.advanceTimersByTime(1_999);
    expect(retry).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(retry).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(600_000);
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("stops listening once disarmed", () => {
    vi.useFakeTimers();
    const s = sources();
    const retry = vi.fn();
    const disarm = armMatrixReconnect(s.triggers, { canRetry: () => true, retry, retryAfterMs: 2_000 });
    disarm();
    s.goOnline();
    s.comeBack();
    vi.advanceTimersByTime(10_000);
    expect(retry).not.toHaveBeenCalled();
    expect(s.net.size).toBe(0);
    expect(s.foreground.size).toBe(0);
  });
});

describe("onForeground", () => {
  it("fires when the document turns visible, not when it is hidden", () => {
    const cb = vi.fn();
    let state: DocumentVisibilityState = "hidden";
    const spy = vi.spyOn(document, "visibilityState", "get").mockImplementation(() => state);
    const off = onForeground(cb);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(cb).not.toHaveBeenCalled();
    state = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    expect(cb).toHaveBeenCalledTimes(1);
    off();
    document.dispatchEvent(new Event("visibilitychange"));
    expect(cb).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("on native also fires when the app becomes active, and removes that listener", async () => {
    native.enabled = true;
    const cb = vi.fn();
    const off = onForeground(cb);
    await vi.waitFor(() => expect(native.appListener).not.toBeNull());
    await Promise.resolve();
    native.appListener!({ isActive: false });
    expect(cb).not.toHaveBeenCalled();
    native.appListener!({ isActive: true });
    expect(cb).toHaveBeenCalledTimes(1);
    off();
    expect(native.remove).toHaveBeenCalledTimes(1);
    native.appListener!({ isActive: true });
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("on native removes the app listener that arrives after it was already disarmed", async () => {
    native.enabled = true;
    const off = onForeground(vi.fn());
    off();
    await vi.waitFor(() => expect(native.remove).toHaveBeenCalledTimes(1));
  });

  it("on web does not touch the Capacitor app plugin", async () => {
    const off = onForeground(vi.fn());
    await Promise.resolve();
    expect(native.appListener).toBeNull();
    off();
  });
});
