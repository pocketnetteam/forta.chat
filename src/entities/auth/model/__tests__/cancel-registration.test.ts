import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const getStoresSource = () =>
  readFileSync(resolve(__dirname, "../stores.ts"), "utf-8");

describe("cancelRegistration", () => {
  it("defines a 10-minute active-time cancel threshold", () => {
    const src = getStoresSource();
    expect(src).toMatch(/REGISTRATION_CANCEL_AFTER_MS\s*=\s*10\s*\*\s*60\s*\*\s*1000/);
  });

  it("tracks poll elapsed time for the cancel button", () => {
    const src = getStoresSource();
    expect(src).toContain("registrationPollElapsedMs");
    const pollStart = src.indexOf("const startRegistrationPoll");
    const pollEnd = src.indexOf("const stopRegistrationPoll");
    const pollSection = src.slice(pollStart, pollEnd);
    expect(pollSection).toMatch(/registrationElapsedInterval|registrationPollElapsedMs/);
    expect(pollSection).toMatch(/pollTimer\?\.elapsed\(\)/);
  });

  it("exposes canCancelRegistration only during active poll phases", () => {
    const src = getStoresSource();
    const computedStart = src.indexOf("const canCancelRegistration = computed");
    expect(computedStart).toBeGreaterThan(-1);
    const block = src.slice(computedStart, computedStart + 450);
    expect(block).toContain("registrationPending");
    expect(block).toContain("REGISTRATION_CANCEL_AFTER_MS");
    expect(block).toContain('"init"');
    expect(block).toContain('"broadcasting"');
    expect(block).toContain('"confirming"');
  });

  it("cancelRegistration resets registration LS keys and delegates to logout", () => {
    const src = getStoresSource();
    const fnStart = src.indexOf("const cancelRegistration = async");
    expect(fnStart).toBeGreaterThan(-1);
    const fn = src.slice(fnStart, fnStart + 700);
    expect(fn).toContain("stopRegistrationPoll");
    expect(fn).toContain("setRegistrationPending(false)");
    expect(fn).toContain("setPendingRegProfile(null)");
    expect(fn).toContain('setRegistrationPhase("init")');
    expect(fn).toContain("clearRegistrationState");
    expect(fn).toContain("await logout()");
  });

  it("logout resets registration_phase to init", () => {
    const src = getStoresSource();
    const logoutStart = src.indexOf("const logout = async");
    expect(logoutStart).toBeGreaterThan(-1);
    const logoutFn = src.slice(logoutStart, logoutStart + 3200);
    expect(logoutFn).toMatch(/setRegistrationPhase\s*\(\s*["']init["']\s*\)/);
  });

  it("exports cancelRegistration and canCancelRegistration", () => {
    const src = getStoresSource();
    expect(src).toContain("cancelRegistration,");
    expect(src).toContain("canCancelRegistration,");
    expect(src).toContain("registrationPollElapsedMs,");
  });
});
