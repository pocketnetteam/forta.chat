import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockPlatform, mockSetEnabled } = vi.hoisted(() => ({
  mockPlatform: { isNative: true },
  mockSetEnabled: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/shared/lib/platform", () => ({
  get isNative() {
    return mockPlatform.isNative;
  },
}));
vi.mock("./push-data-plugin", () => ({
  PushData: { setIncomingCallsEnabled: (...args: unknown[]) => mockSetEnabled(...args) },
}));

import {
  isIncomingCallsEnabled,
  setIncomingCallsEnabled,
  syncIncomingCallsSettingToNative,
} from "./incoming-calls-setting";

describe("incoming calls setting (#1388)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    mockSetEnabled.mockClear();
    mockPlatform.isNative = true;
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
});
