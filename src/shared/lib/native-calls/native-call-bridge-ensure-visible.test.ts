import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

/**
 * WEE-63 / forta-bugs#832, #893 — duplicate incoming-call "answer" dialog.
 *
 * `ensureIncomingCallVisible` prefers the idempotent native method, but on
 * older builds that don't ship it, it falls back to `reportIncomingCall`,
 * which is NOT idempotent: it can stack a second IncomingCallActivity on top
 * of the one the FCM push handler already launched. The regression guard:
 * skip that fallback when the SDK already tracks the callId.
 *
 * Source-level assertion rather than a behavioral test: `nativeCallBridge` is
 * a module singleton whose `sdkHasCall` dynamically imports `@/entities/matrix`.
 * A behavioral test must `vi.mock` platform + `@capacitor/core` + matrix, and
 * those mocks leak across the shared suite (the singleton + dynamic import is
 * not re-isolated per file in this repo's runner), making it order-dependent.
 * The other native/integration regressions here use the same source-level
 * approach for exactly this reason.
 */
const getSource = (): string =>
  readFileSync(resolve(__dirname, "./native-call-bridge.ts"), "utf-8");

describe("nativeCallBridge.ensureIncomingCallVisible — idempotent fallback guard", () => {
  it("prefers the idempotent native ensureIncomingCallVisible when available", () => {
    const source = getSource();
    // The fast path must call the native method and return before any fallback.
    expect(source).toMatch(
      /typeof\s+plugin\.ensureIncomingCallVisible\s*===\s*['"]function['"]/,
    );
    expect(source).toMatch(/await\s+plugin\.ensureIncomingCallVisible\(options\)/);
  });

  it("guards the non-idempotent reportIncomingCall fallback with sdkHasCall", () => {
    const source = getSource();
    const method = source.slice(
      source.indexOf("async ensureIncomingCallVisible"),
      source.indexOf("async reportOutgoingCall"),
    );
    expect(method).not.toBe("");
    // The sdkHasCall check must appear, and it must return early (skip the
    // fallback) before reaching reportIncomingCall.
    const guardIdx = method.indexOf("sdkHasCall(options.callId)");
    const reportIdx = method.lastIndexOf("NativeCall.reportIncomingCall(options)");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(reportIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(reportIdx);
    // There must be a `return` between the guard and the fallback call so the
    // duplicate raise is actually skipped, not merely logged.
    const between = method.slice(guardIdx, reportIdx);
    expect(between).toMatch(/return;/);
  });
});
