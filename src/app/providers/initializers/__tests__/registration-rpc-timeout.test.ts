import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const getSource = () =>
  readFileSync(resolve(__dirname, "../app-initializer.ts"), "utf-8");

/** WEE-23: step-2 (blockchain) registration hangs because the proxy-pinned RPC
 *  calls (`N.pocketnet.app:8899`) never settle when the node is blocked. Each
 *  must be bounded by a per-RPC timeout so the spinner can't hang forever. */
describe("registration RPC timeouts (WEE-23)", () => {
  it("defines a 15s per-RPC registration timeout", () => {
    const src = getSource();
    expect(src).toMatch(/REGISTRATION_RPC_TIMEOUT\s*=\s*15_?000/);
  });

  const guardedMethod = (name: string, fnMarker: string) => {
    it(`${name} wraps its proxy call with withTimeout`, () => {
      const src = getSource();
      const start = src.indexOf(fnMarker);
      expect(start).toBeGreaterThan(-1);
      // Scan a window large enough to cover the method body.
      const body = src.slice(start, start + 1200);
      expect(body).toContain("withTimeout");
      expect(body).toContain("REGISTRATION_RPC_TIMEOUT");
    });
  };

  guardedMethod("getRegistrationProxy", "async getRegistrationProxy");
  guardedMethod("getCaptcha", "async getCaptcha(");
  guardedMethod("solveCaptcha", "async solveCaptcha(");
  guardedMethod("requestFreeRegistration", "async requestFreeRegistration(");
});

/** The store must route captcha fetches through the proxy-fallback helper so a
 *  blocked proxy rotates to another node instead of dead-ending registration. */
describe("registration captcha fallback wiring (WEE-23)", () => {
  it("stores.ts fetchCaptcha uses fetchCaptchaWithProxyFallback", () => {
    const storesSrc = readFileSync(
      resolve(__dirname, "../../../../entities/auth/model/stores.ts"),
      "utf-8",
    );
    expect(storesSrc).toContain("fetchCaptchaWithProxyFallback");
  });
});
