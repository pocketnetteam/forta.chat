import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";

/**
 * Audit S5-01 / S5-02 / W2A-01. The account's own encryption keys were checked
 * (and re-published when missing) only by an explicit login, so an added or
 * switched-to account and every restart of a saved session never checked; the
 * "likely a Bastyon account" verdict of one account leaked into the next; and
 * nobody could tell the user it was THEIR keys that were missing. Source-level,
 * like the other stores.ts contract tests — the store needs the SDK to run.
 */
const source = readFileSync(resolve(__dirname, "../stores.ts"), "utf-8");

function slice(from: string, to: string): string {
  const a = source.indexOf(from);
  expect(a, `${from} not found`).toBeGreaterThan(-1);
  const b = source.indexOf(to, a + from.length);
  expect(b, `${to} not found after ${from}`).toBeGreaterThan(a);
  return source.slice(a, b);
}

describe("own key check (audit S5-01, S5-02, W2A-01)", () => {
  it("checks the keys once per account per app session", () => {
    const once = slice("const verifyOwnKeysOnce = async", "\n  };");
    expect(once).toContain("_keysVerifiedFor.has(current)");
    expect(once).toContain("_keysVerifiedFor.add(current);");
    expect(once).toContain("await verifyAndRepublishKeys();");
    // Every checked account is remembered, not only the last one: A → B → A must
    // not check A again and broadcast a second republish before the first lands.
    expect(source).toContain("const _keysVerifiedFor = new Set<string>();");
  });

  it("checks when Matrix is ready, so restored sessions and switched accounts are covered", () => {
    const ready = slice("if (connectResult.ready) {", "bootStatus.setStep(\"sync\");");
    expect(ready.length).toBeGreaterThan(0);
    const afterReady = slice("chatDbKit.syncEngine.retryNotReadyFailures()", "// Sync Pocketnet name");
    expect(afterReady).toContain("void verifyOwnKeysOnce();");
  });

  it("forgets the checked account on logout", () => {
    const teardown = slice("// ── 3. Clean up listeners & intervals ──", "if (_blockHeightInterval)");
    expect(teardown).toContain("_keysVerifiedFor.clear();");
  });

  it("does not carry one account's key verdicts into the next", () => {
    const swap = slice("// 3. SWAP active account", "// 4. INIT new context");
    expect(swap).toContain("likelyBastyonUser.value = false;");
    expect(swap).toContain("ownKeysMissing.value = false;");
  });

  it("records the account's own missing keys for the chat banner", () => {
    const verify = slice("const verifyAndRepublishKeys = async", "\n  };");
    expect(verify).toMatch(/case "needs-funds":[\s\S]*ownKeysMissing\.value = true;/);
    expect(verify).toMatch(/case "keys-ok":[\s\S]*ownKeysMissing\.value = false;/);
    expect(source).toMatch(/republishKeysFromUi,\s*likelyBastyonUser,\s*ownKeysMissing/);
  });

  // Web bench 2026-10-10: with the Pocketnet nodes unreachable a login with
  // published keys raised the missing-keys banner and the Bastyon flag.
  it("counts the self-profile snapshot's keys and calls an empty answer inconclusive", () => {
    const verify = slice("const verifyAndRepublishKeys = async", "\n  };");
    expect(verify).toContain("const cachedKeyCount = ownKeyCountFromCaches(userData, selfProfile);");
    expect(verify).toMatch(/if \(profileAnswerInconclusive\(rawProfiles, selfProfile\)\) \{[\s\S]*?blockchainCheckFailed = true;/);
  });
});
