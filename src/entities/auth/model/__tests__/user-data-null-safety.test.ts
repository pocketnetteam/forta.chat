import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const getStoresSource = () =>
  readFileSync(resolve(__dirname, "../stores.ts"), "utf-8");
const getAppInitializerSource = () =>
  readFileSync(
    resolve(
      __dirname,
      "../../../../app/providers/initializers/app-initializer.ts",
    ),
    "utf-8",
  );

/**
 * Registration flow calls fetchUserInfo -> initializeAndFetchUserData BEFORE
 * the user's UserInfo exists on-chain. psdk.userInfo.get() returns undefined
 * for those accounts, but the TS cast `as UserData` hides it. The resulting
 * callback call with undefined causes "Invalid private key or mnemonic" on
 * the register page because the thrown TypeError bubbles up through
 * login()'s catch.
 *
 * These tests lock in the two independent fixes:
 *   1. app-initializer guards against null/undefined userData before invoking
 *      the callback (root cause).
 *   2. stores.ts callbacks in fetchUserInfo and onRegistrationConfirmed also
 *      guard defensively so a future refactor cannot silently reintroduce
 *      the crash.
 */
describe("UserData null-safety in registration/login flow", () => {
  it("app-initializer.loadUserData skips the onLoad callback when psdk returns null/undefined", () => {
    const src = getAppInitializerSource();
    const fnStart = src.indexOf("loadUserData(");
    expect(fnStart).toBeGreaterThan(-1);
    const fn = src.slice(fnStart, fnStart + 1000);
    // The callback must be guarded — no unconditional `onLoad(userData)`.
    // Either an explicit userData truthiness check or early-return.
    expect(fn).toMatch(/if\s*\(\s*onLoad\s*&&\s*userData\s*\)|if\s*\(\s*userData\s*\)\s*\{[^}]*onLoad\(/);
  });

  it("fetchUserInfo callback handles userData being undefined", () => {
    const src = getStoresSource();
    const fnStart = src.indexOf("const fetchUserInfo = async () =>");
    expect(fnStart).toBeGreaterThan(-1);
    const fn = src.slice(fnStart, fnStart + 1500);
    // Must guard against undefined userData before dereferencing any field.
    // Old buggy version: `if (userData.name)` — crashes on undefined.
    // Fixed version: `if (userData && userData.name)` or an early guard.
    expect(fn).not.toMatch(/if\s*\(\s*userData\.name\s*\)/);
    expect(fn).toMatch(/if\s*\(\s*userData\s*\?\?|if\s*\(\s*userData\s*&&|if\s*\(\s*!userData\s*\)/);
  });

  it("onRegistrationConfirmed callback handles data being undefined", () => {
    const src = getStoresSource();
    const fnStart = src.indexOf("async function onRegistrationConfirmed");
    expect(fnStart).toBeGreaterThan(-1);
    const fn = src.slice(fnStart, fnStart + 1500);
    // Must not unconditionally reach `data.name ?? ""` — that crashes on undefined.
    // Guard may be either `if (data)` or optional chaining on all field accesses.
    expect(fn).toMatch(/if\s*\(\s*data\s*\)|if\s*\(\s*!data\s*\)|data\?\.name/);
  });
});
