// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockPlatform, mockSetEnabled, mockGetEnabled } = vi.hoisted(() => ({
  mockPlatform: { isNative: true },
  mockSetEnabled: vi.fn().mockResolvedValue(undefined),
  mockGetEnabled: vi.fn().mockResolvedValue({ enabled: true }),
}));

vi.mock("@/shared/lib/platform", () => ({
  get isNative() {
    return mockPlatform.isNative;
  },
}));
vi.mock("./push-data-plugin", () => ({
  PushData: {
    setIncomingCallsEnabled: (...args: unknown[]) => mockSetEnabled(...args),
    getIncomingCallsEnabled: (...args: unknown[]) => mockGetEnabled(...args),
  },
}));

import {
  isIncomingCallsEnabled,
  resolveIncomingCallsEnabled,
  setIncomingCallsEnabled,
  syncIncomingCallsSettingToNative,
  __resetIncomingCallsSettingForTests,
} from "./incoming-calls-setting";

describe("incoming calls setting (#1388)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    mockSetEnabled.mockClear();
    mockGetEnabled.mockReset().mockResolvedValue({ enabled: true });
    mockPlatform.isNative = true;
    __resetIncomingCallsSettingForTests();
  });

  // C05 (calls review 2026-10-04): WebView storage purged, native still "off".
  // JS defaulted to on, so a call arriving through /sync rang anyway and the
  // settings screen showed the switch on.
  it("takes native's choice when JS lost its own, and keeps it", async () => {
    mockGetEnabled.mockResolvedValue({ enabled: false });
    await expect(resolveIncomingCallsEnabled()).resolves.toBe(false);
    expect(isIncomingCallsEnabled()).toBe(false);
    expect(mockSetEnabled).not.toHaveBeenCalled();
  });

  it("prefers the stored JS value over native", async () => {
    window.localStorage.setItem("forta-chat:incoming_calls_enabled", "true");
    mockGetEnabled.mockResolvedValue({ enabled: false });
    await expect(resolveIncomingCallsEnabled()).resolves.toBe(true);
    expect(mockGetEnabled).not.toHaveBeenCalled();
  });

  it("rings when native cannot answer in time", async () => {
    vi.useFakeTimers();
    try {
      mockGetEnabled.mockReturnValue(new Promise(() => {}));
      const resolved = resolveIncomingCallsEnabled();
      await vi.advanceTimersByTimeAsync(600);
      await expect(resolved).resolves.toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("asks native again after a read that timed out (review 2026-10-08)", async () => {
    // A slow first read used to pin the default for the whole process, so a
    // switched-off phone rang for every call until the app restarted.
    vi.useFakeTimers();
    try {
      mockGetEnabled.mockReturnValueOnce(new Promise(() => {}));
      const first = resolveIncomingCallsEnabled();
      await vi.advanceTimersByTimeAsync(600);
      await expect(first).resolves.toBe(true);

      mockGetEnabled.mockResolvedValueOnce({ enabled: false });
      await expect(resolveIncomingCallsEnabled()).resolves.toBe(false);
      expect(mockGetEnabled).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a choice the user made while native's copy was read (review 2026-10-08)", async () => {
    let answer!: (r: { enabled: boolean }) => void;
    mockGetEnabled.mockReturnValueOnce(new Promise((resolve) => { answer = resolve; }));
    const resolved = resolveIncomingCallsEnabled();

    await setIncomingCallsEnabled(false);
    answer({ enabled: true });

    await expect(resolved).resolves.toBe(false);
    expect(window.localStorage.getItem("forta-chat:incoming_calls_enabled")).toBe("false");
  });

  it("the start-up sync restores native's choice instead of pushing the default", async () => {
    mockGetEnabled.mockResolvedValue({ enabled: false });
    await syncIncomingCallsSettingToNative();
    expect(isIncomingCallsEnabled()).toBe(false);
    expect(mockSetEnabled).not.toHaveBeenCalled();
  });

  it("is on by default, so an install that never saw the switch keeps ringing", () => {
    expect(isIncomingCallsEnabled()).toBe(true);
  });

  it("switching off is remembered and handed to native", async () => {
    await setIncomingCallsEnabled(false);

    expect(isIncomingCallsEnabled()).toBe(false);
    expect(mockSetEnabled).toHaveBeenCalledWith({ enabled: false });

    await setIncomingCallsEnabled(true);
    expect(isIncomingCallsEnabled()).toBe(true);
    expect(mockSetEnabled).toHaveBeenLastCalledWith({ enabled: true });
  });

  it("re-sends the stored value to native at start", async () => {
    await setIncomingCallsEnabled(false);
    mockSetEnabled.mockClear();

    await syncIncomingCallsSettingToNative();

    expect(mockSetEnabled).toHaveBeenCalledWith({ enabled: false });
  });

  it("does not call native on the web, and a native failure does not throw", async () => {
    mockPlatform.isNative = false;
    await setIncomingCallsEnabled(false);
    expect(mockSetEnabled).not.toHaveBeenCalled();

    mockPlatform.isNative = true;
    mockSetEnabled.mockRejectedValueOnce(new Error("UNIMPLEMENTED"));
    await expect(syncIncomingCallsSettingToNative()).resolves.toBeUndefined();
  });

  // Regression: a purged WebView storage read as "on" and the start-up sync
  // overwrote native "off", so Forta rang again on its own.
  it("does not push the default to native when nothing is stored", async () => {
    await syncIncomingCallsSettingToNative();
    expect(mockSetEnabled).not.toHaveBeenCalled();
  });
});
