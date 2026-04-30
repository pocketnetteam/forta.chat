import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

/**
 * Regression: AES-SIV ciphertext verification failure on web after refresh.
 *
 * Root cause: `decryptKey` and `decryptEvent` used a try/catch that called
 * `room._decrypt(..., null, v)` first. With usersIds=null, the decrypt path
 * uses `preparedUsers(time, v)` (time-based filtering of room state), which
 * after a tab refresh on web returns a DIFFERENT user set than the sender
 * used at encrypt time (lazy-loaded m.room.member events not yet synced).
 * Different user set → different ECDH cuhash → AES-SIV MAC failure.
 *
 * Fix: always pass the explicit `usersList` derived from the encrypted body
 * keys + sender, matching bastyon-chat/src/application/pcrypto.js:780-792
 * which never passes `null` for usersIds.
 *
 * We assert the source shape because the actual call requires WebCrypto +
 * miscreant + a fully-built room object that is impractical to mock without
 * an extensive harness. The integration is exercised by manual web testing.
 */
const getSource = (): string =>
  readFileSync(resolve(__dirname, "../matrix-crypto.ts"), "utf-8");

function extractFunction(source: string, signature: string): string {
  const start = source.indexOf(signature);
  if (start < 0) throw new Error(`signature not found: ${signature}`);
  // Find the matching closing brace at the same indentation level
  // (each top-level method ends with "\n      },\n" or "\n      }\n" inside the room object)
  const end = source.indexOf("\n      },", start);
  if (end < 0) throw new Error(`closing brace not found for: ${signature}`);
  return source.slice(start, end);
}

describe("decryptKey — always passes explicit usersList (bastyon-chat parity)", () => {
  it("does not contain a try/catch fallback that calls _decrypt with null", () => {
    const source = getSource();
    const fn = extractFunction(source, "async decryptKey(event:");

    // The forbidden pattern: `room._decrypt(..., null, v)` inside a try block.
    // Bastyon parity demands the explicit `usersList` is always passed.
    expect(fn).not.toMatch(/_decrypt\([^)]*?,\s*null,\s*v\)/);
  });

  it("calls _decrypt with the explicit usersList variable", () => {
    const source = getSource();
    const fn = extractFunction(source, "async decryptKey(event:");

    // The single decrypt call must reference `usersList` — the array built
    // from `Object.keys(body)` + `sender`.
    expect(fn).toMatch(/_decrypt\([^)]*usersList[^)]*\)/);
  });

  it("builds usersList from body keys + sender before decrypting", () => {
    const source = getSource();
    const fn = extractFunction(source, "async decryptKey(event:");

    expect(fn).toMatch(/const\s+usersList\s*=\s*\[\s*\.\.\.new\s+Set\(\s*\[\s*\.\.\.bodyUsers,\s*sender\s*\]\s*\)\s*\]/);
  });
});

describe("decryptEvent — always passes explicit usersList (bastyon-chat parity)", () => {
  it("does not contain a try/catch fallback that calls _decrypt with null", () => {
    const source = getSource();
    const fn = extractFunction(source, "async decryptEvent(event:");

    expect(fn).not.toMatch(/_decrypt\([^)]*?,\s*null,\s*eventVersion\)/);
  });

  it("calls _decrypt with the explicit usersList variable", () => {
    const source = getSource();
    const fn = extractFunction(source, "async decryptEvent(event:");

    expect(fn).toMatch(/_decrypt\([^)]*usersList[^)]*\)/);
  });
});
