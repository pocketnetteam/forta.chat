import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

/**
 * Regression tests pinning the safety contract of `republishKeysFromUi()`
 * and `verifyAndRepublishKeys()`.
 *
 * App.vue mounts RegistrationStepper as a full-screen overlay whenever
 * `registrationPending` is truthy. Neither the chat-room banner button
 * (republishKeysFromUi) nor the login-path key check (verifyAndRepublishKeys,
 * which runs for an already-authenticated account) may flip that state —
 * doing so hangs an existing-account session on "Подготовка аккаунта"
 * (WEE-35 / forta-bugs#520). Both must broadcast keys silently in the
 * background instead.
 */

const storesSource = readFileSync(
  resolve(__dirname, "../stores.ts"),
  "utf-8",
);

function extractFunctionBody(name: string): string {
  const startIdx = storesSource.indexOf(`const ${name} = async (`);
  if (startIdx === -1) throw new Error(`function ${name} not found`);
  // Look ahead for the closing `};` at indent 0 ("\n  };") — every
  // store-scoped const ends with two-space `};`.
  const endMarker = "\n  };";
  const endIdx = storesSource.indexOf(endMarker, startIdx);
  if (endIdx === -1) throw new Error(`end of ${name} not found`);
  return storesSource.slice(startIdx, endIdx);
}

describe("republishKeysFromUi safety", () => {
  // republishKeysFromUi wraps republishOwnKeys (the verify-and-broadcast body)
  // and records the verdict in ownKeysMissing for the chat banner (audit W2A-01).
  const uiBody = () => extractFunctionBody("republishKeysFromUi") + extractFunctionBody("republishOwnKeys");

  it("does not flip registrationPending on the republish path", () => {
    const body = uiBody();
    expect(body).not.toContain("setRegistrationPending(true)");
    expect(body).not.toContain("startRegistrationPoll(");
    expect(body).not.toContain("setPendingRegProfile(");
  });

  it("records whether this account's own keys are still missing", () => {
    const body = extractFunctionBody("republishKeysFromUi");
    expect(body).toContain("await republishOwnKeys()");
    expect(body).toContain("ownKeysMissing.value = false");
    expect(body).toContain("ownKeysMissing.value = true");
  });

  it("returns a typed result with all four UI-relevant states", () => {
    const body = uiBody();
    expect(body).toContain('state: "already-ok"');
    expect(body).toContain('state: "republished"');
    expect(body).toContain('state: "needs-funds"');
    expect(body).toContain('state: "broadcast-failed"');
  });

  it("guards against running while a real registration is already in flight", () => {
    const body = uiBody();
    // If registrationPending is already true (login flow re-publishing), the
    // UI variant must short-circuit instead of racing the legitimate poll.
    expect(body).toContain("registrationPending.value");
    expect(body).toContain('state: "skipped"');
  });

  it("is exported from the auth store", () => {
    // The store's return block must list republishKeysFromUi so the
    // ChatWindow banner can reach it.
    const returnBlockIdx = storesSource.lastIndexOf("return {");
    expect(returnBlockIdx).toBeGreaterThan(-1);
    const returnBlock = storesSource.slice(returnBlockIdx);
    expect(returnBlock).toContain("republishKeysFromUi");
  });
});

describe("verifyAndRepublishKeys (login path) never mounts the registration UI", () => {
  // WEE-35 / forta-bugs#520: this runs on the login path for an
  // ALREADY-AUTHENTICATED account. Flipping `registrationPending` mounts the
  // full-screen RegistrationStepper ("Подготовка аккаунта / Requesting
  // resources for registration") over a valid session and hangs the user —
  // the visible symptom for Bastyon-registered accounts (whose blockchain
  // profile lacks Forta's 12 keys) and for transient empty-keys RPC responses.
  it("does not flip registrationPending or start the stepper poll", () => {
    const body = extractFunctionBody("verifyAndRepublishKeys");
    expect(body).not.toContain("setRegistrationPending(true)");
    expect(body).not.toContain("startRegistrationPoll(");
    expect(body).not.toContain("setPendingRegProfile(");
  });

  it("still re-publishes keys in the background when the account is funded", () => {
    // The fix degrades to a silent broadcast — it must keep calling
    // registerUserProfile so encryption keys actually get published.
    const body = extractFunctionBody("verifyAndRepublishKeys");
    expect(body).toContain("registerUserProfile");
    expect(body).toContain('action.kind');
  });
});

// Review 2026-10-08 (H2): an account switch between the awaits published A's
// profile under B's address and keys.
describe("verifyAndRepublishKeys stays with the account it started for", () => {
  it("captures the account at entry and checks it after each await", () => {
    const body = extractFunctionBody("verifyAndRepublishKeys");
    expect(body).toContain("const subjectAddress = address.value;");
    expect(body).toContain("const subjectKey = privateKey.value;");
    expect(body).toContain("generateEncryptionKeys(subjectKey)");
    expect(body).not.toContain("generateEncryptionKeys(privateKey.value)");
    // After the RPC check, after checkUnspents, and right before the broadcast.
    expect(body.match(/accountChanged\(\)/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
    const broadcast = body.indexOf("registerUserProfile(");
    const lastCheck = body.lastIndexOf("accountChanged()");
    expect(lastCheck).toBeLessThan(broadcast);
  });
});
