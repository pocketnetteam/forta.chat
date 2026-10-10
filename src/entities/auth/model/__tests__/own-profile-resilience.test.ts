import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

/**
 * Regression: one failed own-profile getuserprofile at boot broke the whole
 * session until a manual reload.
 *  - The Pocketnet SDK user (address + key pair → signed requests, wallet) was
 *    configured ONLY inside the successful-load callback of fetchUserInfo.
 *  - The failure was logged as "non-fatal" and never retried.
 * Fix: configure the SDK user before the network call (both values are local)
 * and retry the load with backoff (createBackoffRetry, behaviour covered in
 * lib/__tests__/backoff-retry.test.ts).
 *
 * Source-level, like the other auth-store tests here: the store pulls in
 * Matrix, Dexie, push and the SDK and has no behavioural harness.
 */
const src = readFileSync(resolve(__dirname, "../stores.ts"), "utf-8");
const fetchUserInfo = (() => {
  const start = src.indexOf("const fetchUserInfo = async () =>");
  const end = src.indexOf("const verifyAndRepublishKeys", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
})();

describe("own profile load resilience", () => {
  it("configures the SDK user before the network call, not in its success callback", () => {
    const configureIdx = fetchUserInfo.indexOf("configureSdkUser(requestAddress, requestPrivateKey)");
    const networkIdx = fetchUserInfo.indexOf("initializeAndFetchUserData(");
    expect(configureIdx).toBeGreaterThan(-1);
    expect(networkIdx).toBeGreaterThan(configureIdx);
    expect(fetchUserInfo).not.toContain("PocketnetInstanceConfigurator.setUserAddress");
  });

  it("configureSdkUser sets both the address and the key pair", () => {
    const start = src.indexOf("const configureSdkUser = ");
    const body = src.slice(start, src.indexOf("};", start));
    expect(body).toContain("PocketnetInstanceConfigurator.setUserAddress(addr)");
    expect(body).toContain("PocketnetInstanceConfigurator.setUserGetKeyPairFc(");
  });

  it("schedules a retry when the load fails and cancels it once it succeeds", () => {
    const catchIdx = fetchUserInfo.lastIndexOf("} catch (e) {");
    expect(fetchUserInfo.slice(catchIdx)).toContain("scheduleOwnProfileRetry(requestAddress)");
    expect(fetchUserInfo.slice(0, catchIdx)).toContain("cancelOwnProfileRetry()");
  });

  it("keeps retrying when the load resolves to null (API not ready) instead of cancelling", () => {
    const catchIdx = fetchUserInfo.lastIndexOf("} catch (e) {");
    const success = fetchUserInfo.slice(0, catchIdx);
    expect(success).toMatch(/const loaded = await withTimeout\(/);
    expect(success).toMatch(/if \(loaded\) cancelOwnProfileRetry\(\);\s*else scheduleOwnProfileRetry\(requestAddress\);/);
  });

  it("the retry only re-runs for the same account", () => {
    const start = src.indexOf("const scheduleOwnProfileRetry = ");
    const body = src.slice(start, src.indexOf("const fetchUserInfo", start));
    expect(body).toMatch(/if\s*\(\s*address\.value\s*!==\s*requestAddress\s*\)\s*return/);
  });

  it("logout and account switch drop a pending retry", () => {
    const logout = src.slice(src.indexOf("const logout = async () =>"));
    expect(logout.slice(0, 400)).toContain("cancelOwnProfileRetry()");
    const swap = src.indexOf("sessionManager.setActive(targetAddress)");
    expect(src.slice(swap, swap + 300)).toContain("cancelOwnProfileRetry()");
  });
});
