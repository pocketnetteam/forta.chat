import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const getStoresSource = () =>
  readFileSync(resolve(__dirname, "../stores.ts"), "utf-8");

/** Regression coverage for moving PKOIN funding from register() (the final
 *  wizard step, reached only after the user reviews/copies their mnemonic —
 *  an arbitrarily long, user-controlled delay) into a dedicated
 *  requestRegistrationFunding() called right after the captcha is solved.
 *  Deferring funding widened the window during which a single-use/
 *  time-limited captcha grant could expire, and on failure register() had
 *  no recovery path — it just reused the same stale regCaptchaId/regProxyId
 *  on every "Retry" click. See the 2026-08-29 registration audit /
 *  captcha-flow-bridge findings. */
describe("registration: captcha funding happens at solve-time, not at final register()", () => {
  it("requestRegistrationFunding requests free registration (PKOIN)", () => {
    const src = getStoresSource();
    const start = src.indexOf("const requestRegistrationFunding = async");
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf("\n  };", start);
    const fn = src.slice(start, end);
    expect(fn).toContain("appInitializer.requestFreeRegistration");
  });

  it("requestRegistrationFunding resets regCaptchaId on failure so a retry gets a fresh captcha", () => {
    const src = getStoresSource();
    const start = src.indexOf("const requestRegistrationFunding = async");
    const end = src.indexOf("\n  };", start);
    const fn = src.slice(start, end);
    expect(fn).toMatch(/regCaptchaId\.value\s*=\s*null/);
    expect(fn).toMatch(/regCaptchaDone\.value\s*=\s*false/);
  });

  it("submitCaptcha only verifies the captcha text — no funding call inside it", () => {
    const src = getStoresSource();
    const start = src.indexOf("const submitCaptcha = async");
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf("\n  };", start);
    const fn = src.slice(start, end);
    expect(fn).not.toContain("requestFreeRegistration");
  });

  it("register() no longer calls requestFreeRegistration — funding already happened via requestRegistrationFunding", () => {
    const src = getStoresSource();
    const start = src.indexOf("const register = async (profile:");
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf("\n  const retryRegistrationWithNewName", start);
    const fn = src.slice(start, end);
    expect(fn).not.toContain("requestFreeRegistration");
  });

  it("register() requires regCaptchaDone instead of regCaptchaId/regProxyId", () => {
    const src = getStoresSource();
    const start = src.indexOf("const register = async (profile:");
    const guardEnd = src.indexOf("Registration state incomplete", start);
    expect(guardEnd).toBeGreaterThan(-1);
    const guard = src.slice(start, guardEnd);
    expect(guard).toContain("regCaptchaDone.value");
  });
});
