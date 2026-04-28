import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

/**
 * Regression tests for requiresEncryption() vs canBeEncrypt() divergence.
 *
 * Bug (introduced by PR #64 — c921707):
 *   requiresEncryption() checks only `publicChat`. canBeEncrypt() also
 *   returns false for rooms with ≥50 members (Bastyon disables E2E for
 *   large rooms by design — plaintext is the convention). After PR #64
 *   the SyncEngine evaluates `canBeEncrypt() === false` on every send
 *   into a large private group, then falls through to the
 *   requiresEncryption() guard which, having only the publicChat gate,
 *   returns true and throws ENCRYPTION_REQUIRED_NO_KEYS. Result: every
 *   message to a large private group is permanently stranded in the
 *   outbound queue.
 *
 *   chat-store.ts already classifies memberCount≥50 as "not-encrypted"
 *   so the UI gate (peerKeysOk) happily enqueues the send — SyncEngine
 *   then blocks it, leaving the compose UI looking functional while
 *   nothing actually leaves the device.
 *
 * Fix: requiresEncryption() must mirror canBeEncrypt()'s member-count
 * gate so the two signals agree on which rooms mandate encryption.
 */
const getSource = () =>
  readFileSync(resolve(__dirname, "../matrix-crypto.ts"), "utf-8");

describe("requiresEncryption — large-room gate", () => {
  it("exempts rooms with ≥50 members from the encryption requirement", () => {
    const source = getSource();
    const start = source.indexOf("requiresEncryption(): boolean {");
    expect(start).toBeGreaterThan(-1);
    const end = source.indexOf("\n      },", start);
    const section = source.slice(start, end);

    // Must recognise the ≥50 threshold — plaintext is expected there by
    // Bastyon convention (same gate as canBeEncrypt() uses).
    expect(section).toContain("50");
    expect(section).toMatch(/memberCount|getJoinedMemberCount/);
  });

  it("still returns false for public chats first (short-circuit)", () => {
    const source = getSource();
    const start = source.indexOf("requiresEncryption(): boolean {");
    const end = source.indexOf("\n      },", start);
    const section = source.slice(start, end);

    // publicChat check must appear before the member-count check so
    // public rooms never hit the (slightly more expensive) count lookup.
    const publicIdx = section.indexOf("getIsChatPublic");
    const memberIdx = section.search(/getJoinedMemberCount|memberCount/);
    expect(publicIdx).toBeGreaterThan(-1);
    expect(memberIdx).toBeGreaterThan(-1);
    expect(publicIdx).toBeLessThan(memberIdx);
  });
});
