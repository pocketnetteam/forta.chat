import { describe, it, expect } from "vitest";
import { BATTERY_HINT_REPEAT_MS, shouldShowBatteryHint, type BatteryHintInput } from "./battery-hint-policy";

const NOW = 1_800_000_000_000;
const base: BatteryHintInput = {
  isAndroidNative: true,
  signedIn: true,
  incomingCallsEnabled: true,
  ignoringOptimizations: false,
  disabled: false,
  lastShownAt: null,
  now: NOW,
};

describe("shouldShowBatteryHint (missed push calls T3)", () => {
  it("shows once after sign-in on an optimized Android app with incoming calls on", () => {
    expect(shouldShowBatteryHint(base)).toBe(true);
  });

  it("waits 30 days before showing again", () => {
    expect(shouldShowBatteryHint({ ...base, lastShownAt: NOW - BATTERY_HINT_REPEAT_MS + 1 })).toBe(false);
    expect(shouldShowBatteryHint({ ...base, lastShownAt: NOW - BATTERY_HINT_REPEAT_MS })).toBe(true);
  });

  it("stays hidden when the app is already exempt or Android did not answer", () => {
    expect(shouldShowBatteryHint({ ...base, ignoringOptimizations: true })).toBe(false);
    expect(shouldShowBatteryHint({ ...base, ignoringOptimizations: null })).toBe(false);
  });

  it("stays hidden off Android, signed out, with incoming calls off or the reminder off", () => {
    expect(shouldShowBatteryHint({ ...base, isAndroidNative: false })).toBe(false);
    expect(shouldShowBatteryHint({ ...base, signedIn: false })).toBe(false);
    expect(shouldShowBatteryHint({ ...base, incomingCallsEnabled: false })).toBe(false);
    expect(shouldShowBatteryHint({ ...base, disabled: true })).toBe(false);
  });
});
