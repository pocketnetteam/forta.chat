import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

/**
 * Source-level regression tests for device_id persistence in matrix-client.ts.
 *
 * Rationale: matrix-client.ts wires the Matrix SDK directly and mocking it in
 * isolation would require stubbing IndexedDB/Dexie/sync filters — too much
 * surface for a single behavior. Instead we assert on the source to make sure
 * the critical lines (read before login, write after login) cannot silently
 * disappear during refactors.
 *
 * The actual read/write logic is covered by device-id-storage.test.ts.
 */

const getSource = () =>
  readFileSync(resolve(__dirname, "../matrix-client.ts"), "utf-8");

describe("matrix-client device_id persistence", () => {
  it("imports getStoredDeviceId and storeDeviceId from device-id-storage", () => {
    const source = getSource();
    expect(source).toMatch(
      /import\s*\{[^}]*getStoredDeviceId[^}]*\}\s*from\s*["']\.\/device-id-storage["']/,
    );
    expect(source).toMatch(
      /import\s*\{[^}]*storeDeviceId[^}]*\}\s*from\s*["']\.\/device-id-storage["']/,
    );
  });

  it("reads the stored device_id using the account address before login", () => {
    const source = getSource();
    const getClientStart = source.indexOf("private async passwordLogin(");
    expect(getClientStart).toBeGreaterThan(-1);

    // Search only within the passwordLogin method to avoid matching unrelated code
    const getClientBody = source.slice(getClientStart, getClientStart + 4000);

    expect(getClientBody).toContain(
      "getStoredDeviceId(this.credentials.address)",
    );

    // The read must happen before client.login is called
    const readIdx = getClientBody.indexOf("getStoredDeviceId");
    const loginIdx = getClientBody.indexOf("client.login(");
    expect(readIdx).toBeGreaterThan(-1);
    expect(loginIdx).toBeGreaterThan(-1);
    expect(readIdx).toBeLessThan(loginIdx);
  });

  it("passes device_id into the login params when one was stored", () => {
    const source = getSource();
    // Matches:
    //   if (storedDeviceId) {
    //     loginParams.device_id = storedDeviceId;
    //   }
    expect(source).toMatch(
      /if\s*\(\s*storedDeviceId\s*\)\s*\{\s*loginParams\.device_id\s*=\s*storedDeviceId/,
    );
  });

  it("persists the device_id after a successful login/register", () => {
    const source = getSource();
    const getClientStart = source.indexOf("private async passwordLogin(");
    const getClientBody = source.slice(getClientStart, getClientStart + 4000);

    expect(getClientBody).toContain(
      "storeDeviceId(this.credentials.address, userData.device_id)",
    );

    // The persist call must happen AFTER the login/register block finishes —
    // i.e. after userData is assigned. A reasonable proxy: it must appear
    // after the last client.login or client.register call.
    const lastLoginIdx = Math.max(
      getClientBody.lastIndexOf("client.login("),
      getClientBody.lastIndexOf("client.register("),
    );
    const storeIdx = getClientBody.indexOf("storeDeviceId(");
    expect(lastLoginIdx).toBeGreaterThan(-1);
    expect(storeIdx).toBeGreaterThan(-1);
    expect(storeIdx).toBeGreaterThan(lastLoginIdx);
  });

  it("does NOT call login without any device_id handling (regression guard)", () => {
    const source = getSource();
    // The old buggy form was a literal `client.login("m.login.password", { user, password })`
    // with no mention of device_id anywhere around it. We assert that within
    // the getClient method the identifier `device_id` is present near the
    // login call.
    const getClientStart = source.indexOf("private async passwordLogin(");
    const getClientBody = source.slice(getClientStart, getClientStart + 4000);
    expect(getClientBody).toMatch(/device_id/);
  });
});
