import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

/**
 * Regression tests pinning the safety contract of `republishKeysFromUi()`.
 *
 * The original `verifyAndRepublishKeys()` flips `registrationPending` and
 * starts a registration poll on a republish-needed path — that's correct for
 * login but a foot-gun when the same call is wired to a chat-room banner
 * button (App.vue mounts RegistrationStepper as a full-screen overlay
 * whenever `registrationPending` is truthy). The UI variant must broadcast
 * keys without touching that registration-pending state.
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
  it("does not flip registrationPending on the republish path", () => {
    const body = extractFunctionBody("republishKeysFromUi");
    expect(body).not.toContain("setRegistrationPending(true)");
    expect(body).not.toContain("startRegistrationPoll(");
    expect(body).not.toContain("setPendingRegProfile(");
  });

  it("returns a typed result with all four UI-relevant states", () => {
    const body = extractFunctionBody("republishKeysFromUi");
    expect(body).toContain('state: "already-ok"');
    expect(body).toContain('state: "republished"');
    expect(body).toContain('state: "needs-funds"');
    expect(body).toContain('state: "broadcast-failed"');
  });

  it("guards against running while a real registration is already in flight", () => {
    const body = extractFunctionBody("republishKeysFromUi");
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

describe("verifyAndRepublishKeys (login path) is intact", () => {
  it("still flips registrationPending on the republish path", () => {
    // Sanity check — the login path needs the registration overlay so the
    // user sees the poll progress. Don't accidentally degrade it while
    // refactoring the UI variant.
    const body = extractFunctionBody("verifyAndRepublishKeys");
    expect(body).toContain("setRegistrationPending(true)");
    expect(body).toContain("startRegistrationPoll(");
  });
});
