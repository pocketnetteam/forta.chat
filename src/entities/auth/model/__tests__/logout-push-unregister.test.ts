import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

/**
 * Source-level regression: logout left this device's pusher on the homeserver,
 * and a signed-out Pixel kept ringing for the account (TEST3, 2026-09-24).
 * The pusher can only be deleted while the Matrix client still holds its
 * access token, so the unregister must come before the client is torn down.
 * Behaviour of the unregister itself: src/shared/lib/push/push-service-logout.test.ts.
 */
const logoutBlock = (): string => {
  const src = readFileSync(resolve(__dirname, "../stores.ts"), "utf-8");
  const start = src.indexOf("const logout = async () =>");
  expect(start).toBeGreaterThan(-1);
  return src.slice(start, start + 6000);
};

describe("logout stops this device's pushes", () => {
  it("awaits the push unregister before the Matrix client is reset", () => {
    const block = logoutBlock();
    const unregister = block.indexOf("await pushService.unregisterForLogout()");
    const reset = block.indexOf("resetMatrixClientService()");
    expect(unregister).toBeGreaterThan(-1);
    expect(reset).toBeGreaterThan(-1);
    expect(unregister).toBeLessThan(reset);
  });

  it("settles pushes when the app starts with nobody signed in", () => {
    const app = readFileSync(resolve(__dirname, "../../../../app/App.vue"), "utf-8");
    expect(app).toMatch(/else if \(!authStore\.isAuthenticated\)[\s\S]{0,200}settleSignedOutLaunch\(\)/);
  });
});
