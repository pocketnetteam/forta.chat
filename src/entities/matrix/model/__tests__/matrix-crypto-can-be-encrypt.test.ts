import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

/**
 * Regression tests for canBeEncrypt() and encryptEvent() guards.
 *
 * Bug: Array.prototype.every returns true for empty arrays. If usersinfoArray
 * was empty (race with Matrix /sync — peer keys not yet loaded), canBeEncrypt
 * returned true, encryptEvent shipped a body encrypted to ZERO recipients
 * (Base64.encode("{}") === "e30="), and the receiver got "emptyforme" /
 * AES-SIV ciphertext-verification-failed errors.
 *
 * Source verification — checking the *literal* code shape because the actual
 * crypto module pulls in miscreant + WebCrypto and is impractical to unit-test
 * without an extensive harness. The wider behavior is exercised by integration
 * tests in chat-store.
 */
const getSource = () =>
  readFileSync(resolve(__dirname, "../matrix-crypto.ts"), "utf-8");

describe("canBeEncrypt — empty usersinfoArray guard", () => {
  it("explicitly bails out before .every() when there are fewer than 2 users", () => {
    const source = getSource();
    const start = source.indexOf("canBeEncrypt(): boolean {");
    expect(start).toBeGreaterThan(-1);
    const end = source.indexOf("\n      },", start);
    const section = source.slice(start, end);

    // Guard must appear BEFORE the .every() call so the empty array can never
    // short-circuit to true via the JS spec quirk.
    const guardIdx = section.indexOf("usersinfoArray.length < 2");
    const everyIdx = section.indexOf(".every(");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(everyIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(everyIdx);
  });
});

describe("encryptEvent — refuse to ship empty body", () => {
  it("throws when the prepared recipient list is empty", () => {
    const source = getSource();
    const start = source.indexOf("async encryptEvent(text");
    expect(start).toBeGreaterThan(-1);
    const section = source.slice(start, start + 2000);

    // Guard must throw if no recipients survived preparedUsers filter, instead
    // of silently producing Base64.encode("{}") and shipping it to the room.
    expect(section).toMatch(/_users\.length\s*===\s*0|_users\.length\s*<\s*1/);
    expect(section).toContain("No recipients with published keys");
  });
});
