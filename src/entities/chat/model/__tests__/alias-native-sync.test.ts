import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Audit S6-01, device check 2026-10-10: with the page asleep Android draws the
 * notification title natively, and it never had the contact aliases. The auth
 * store hands them over by Matrix user id, and every alias change resyncs them.
 * Source-level: both stores need the whole app to mount.
 */
const chatStore = readFileSync(resolve(__dirname, "../chat-store.ts"), "utf-8");
const authStore = readFileSync(resolve(__dirname, "../../../auth/model/stores.ts"), "utf-8");

describe("contact aliases reach native notification titles", () => {
  it("resyncs them on every alias change in the native app", () => {
    const at = chatStore.indexOf("const localAliases = ref<Record<string, string>>({});");
    const block = chatStore.slice(at, at + 600);
    expect(block).toMatch(/if \(isNative\) \{\s*watch\(localAliases,/);
    expect(block).toContain("pushService.syncSenderAliasesToNative()");
  });

  it("keys them by the sender's Matrix user id", () => {
    const at = authStore.indexOf("pushService.setSenderAliasesGetter(");
    expect(at).toBeGreaterThan(0);
    expect(authStore.slice(at, at + 400)).toContain("aliases[matrixService.matrixId(hexEncode(addr))] = alias;");
  });
});
