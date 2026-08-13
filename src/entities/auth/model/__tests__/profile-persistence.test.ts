import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

/**
 * Source-level regression: ensures the WEE-26 self-profile cache stays wired
 * into the auth store. These guards exist because the previous behaviour —
 * unconditionally accepting a Pocketnet response — silently re-introduced
 * forta-bugs#596 / #580 whenever someone refactored fetchUserInfo.
 *
 * Behaviour of the cache helpers themselves lives in
 * src/entities/auth/lib/__tests__/self-profile-cache.test.ts.
 */
const getStoresSource = () =>
  readFileSync(resolve(__dirname, "../stores.ts"), "utf-8");

describe("auth store wires the self-profile cache (WEE-26)", () => {
  it("imports the cache helpers from ../lib", () => {
    const src = getStoresSource();
    expect(src).toMatch(/readSelfProfile\b/);
    expect(src).toMatch(/writeSelfProfile\b/);
    expect(src).toMatch(/mergeSelfProfileWithRemote\b/);
  });

  it("persists the snapshot inside the editUserData success path", () => {
    const src = getStoresSource();
    const start = src.indexOf("const { execute: editUserData");
    expect(start).toBeGreaterThan(-1);
    const block = src.slice(start, start + 3000);
    expect(block).toMatch(/result\?\.success\s*===\s*true/);
    expect(block).toMatch(/writeSelfProfile\(/);
    expect(block).toMatch(/localEditedAt:\s*Date\.now\(\)/);
  });

  it("updates in-memory userInfo right after a successful save", () => {
    const src = getStoresSource();
    const start = src.indexOf("const { execute: editUserData");
    const block = src.slice(start, start + 3000);
    // Must call setUserInfo with the merged payload so the form reflects
    // the save without waiting for another fetchUserInfo.
    expect(block).toMatch(/setUserInfo\(merged\)/);
  });

  it("fetchUserInfo merges the cached snapshot into the Pocketnet response", () => {
    const src = getStoresSource();
    const start = src.indexOf("const fetchUserInfo = async () =>");
    expect(start).toBeGreaterThan(-1);
    // Window widened (WEE-XX): initializeAndFetchUserData is now wrapped in
    // withTimeout (unguarded-hang fix), pushing writeSelfProfile's syncedAt further in.
    const block = src.slice(start, start + 3500);
    expect(block).toMatch(/readSelfProfile\(/);
    expect(block).toMatch(/mergeSelfProfileWithRemote\(/);
    // Must call setUserInfo with the merged result — not the raw userData.
    expect(block).toMatch(/setUserInfo\(merged\)/);
    // And persist the merged snapshot with a fresh syncedAt
    expect(block).toMatch(/writeSelfProfile\(/);
    expect(block).toMatch(/syncedAt:\s*Date\.now\(\)/);
  });

  it("does not set userInfo from the raw Pocketnet userData any more", () => {
    const src = getStoresSource();
    const start = src.indexOf("const fetchUserInfo = async () =>");
    const block = src.slice(start, start + 3000);
    // Old buggy behaviour: setUserInfo(userData) — directly trusting RPC.
    expect(block).not.toMatch(/setUserInfo\(userData\)/);
  });

  it("onRegistrationConfirmed merges instead of replacing", () => {
    const src = getStoresSource();
    const start = src.indexOf("async function onRegistrationConfirmed");
    expect(start).toBeGreaterThan(-1);
    const block = src.slice(start, start + 3000);
    expect(block).toMatch(/mergeSelfProfileWithRemote\(/);
    expect(block).toMatch(/setUserInfo\(merged\)/);
    expect(block).toMatch(/writeSelfProfile\(/);
  });

  it("logout invokes clearSelfProfile to drop the per-address snapshot", () => {
    const src = getStoresSource();
    const start = src.indexOf("const logout = async () =>");
    expect(start).toBeGreaterThan(-1);
    const block = src.slice(start, start + 4000);
    expect(block).toMatch(/clearSelfProfile\(/);
  });

  it("fetchUserInfo snapshots the active address before awaiting the RPC", () => {
    const src = getStoresSource();
    const start = src.indexOf("const fetchUserInfo = async () =>");
    const block = src.slice(start, start + 3000);
    // Captured snapshot prevents a logout-mid-fetch race from leaking
    // profile state across accounts.
    expect(block).toMatch(/const\s+requestAddress\s*=\s*address\.value/);
    expect(block).toMatch(/if\s*\(\s*address\.value\s*!==\s*requestAddress\s*\)/);
  });

  it("editUserData snapshots the active address before broadcasting", () => {
    const src = getStoresSource();
    const start = src.indexOf("const { execute: editUserData");
    const block = src.slice(start, start + 3000);
    expect(block).toMatch(/const\s+editAddress\s*=\s*address\.value/);
    expect(block).toMatch(/address\.value\s*===\s*editAddress/);
  });
});
