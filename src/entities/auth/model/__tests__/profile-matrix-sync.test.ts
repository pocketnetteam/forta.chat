import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

/**
 * Source-level regression: auth store's editUserData callback must trigger a
 * best-effort Matrix profile sync after the Pocketnet edit succeeds.
 *
 * Behavioral coverage of the helper itself lives in
 * src/entities/auth/lib/__tests__/sync-profile-to-matrix.test.ts.
 */
const getStoresSource = () =>
  readFileSync(resolve(__dirname, "../stores.ts"), "utf-8");

describe("auth store editUserData triggers Matrix profile sync (Session 45)", () => {
  it("imports syncProfileToMatrix from ../lib", () => {
    const src = getStoresSource();
    expect(src).toMatch(/syncProfileToMatrix/);
    expect(src).toMatch(/from\s+["']\.\.\/lib["']/);
  });

  it("calls syncProfileToMatrix inside the editUserData useAsyncOperation callback", () => {
    const src = getStoresSource();
    const start = src.indexOf("const { execute: editUserData");
    expect(start).toBeGreaterThan(-1);
    const block = src.slice(start, start + 1500);
    expect(block).toMatch(/syncProfileToMatrix\(/);
  });

  it("guards Matrix sync behind matrixReady so we don't sync before login completes", () => {
    const src = getStoresSource();
    const start = src.indexOf("const { execute: editUserData");
    const block = src.slice(start, start + 1500);
    expect(block).toMatch(/matrixReady/);
  });

  it("only syncs when blockchain edit succeeded", () => {
    const src = getStoresSource();
    const start = src.indexOf("const { execute: editUserData");
    const block = src.slice(start, start + 1500);
    // Either explicit success === true check, or success !== false guard
    expect(block).toMatch(/success\s*===\s*true|success\s*!==\s*false/);
  });

  it("fires Matrix sync without blocking the save (no await on syncProfileToMatrix)", () => {
    const src = getStoresSource();
    const start = src.indexOf("const { execute: editUserData");
    const block = src.slice(start, start + 1500);
    // Look for a `void syncProfileToMatrix(...)` fire-and-forget pattern.
    // Plain `await syncProfileToMatrix` would re-introduce H3 (UI hang).
    expect(block).toMatch(/void\s+syncProfileToMatrix\s*\(/);
  });
});
