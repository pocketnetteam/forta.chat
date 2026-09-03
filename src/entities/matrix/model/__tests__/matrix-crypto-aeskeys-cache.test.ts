import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

/**
 * Regression: group E2EE messages failed to decrypt after lazyLoadMembers
 * was disabled (WEE — group decrypt after full member sync).
 *
 * Root cause: the main-thread fallback for aeskeys() cached derived AES keys
 * under `${time}|${block}|${usersIds ? usersIds.join(",") : ""}|${v}`. For
 * group _encrypt()/_decrypt() calls, usersIds is always null and (time,
 * block) are constants (0, 10) — so the cache key degenerated to a single
 * value per room+version, identical across every call regardless of the
 * actual resolved member set. The FIRST call in a room's session (often
 * against an incomplete member snapshot, since full non-lazy member sync
 * arrives progressively) got permanently cached and silently reused for
 * every later encrypt/decrypt in that room, even after membership/keys
 * changed — producing wrong AES-SIV keys and undecryptable messages.
 *
 * Fix: restore the original bastyon-chat pcrypto.js caching scheme
 * (eaac.aeskeysls, lines 348-396) that this file's Web Worker perf pass
 * (commit f5e7075a) replaced with the buggy ad-hoc `_aesKeyCache` — a
 * persistent, membership-aware cache keyed on orderedIdsHash(usersIds) for
 * an explicit list, or period(time) (an index into the join/leave history)
 * for the implicit "current room members" case, so a membership change
 * always busts the cache instead of silently reusing a stale entry.
 *
 * Source verification — checking the *literal* code shape because the
 * actual crypto module pulls in miscreant + WebCrypto + IndexedDB and is
 * impractical to unit-test without an extensive harness (see sibling tests
 * in this directory for the established convention).
 */
const getSource = (): string =>
  readFileSync(resolve(__dirname, "../matrix-crypto.ts"), "utf-8");

function extractFunction(source: string, signature: string): string {
  const start = source.indexOf(signature);
  if (start < 0) throw new Error(`signature not found: ${signature}`);
  const end = source.indexOf("\n      },", start);
  if (end < 0) throw new Error(`closing brace not found for: ${signature}`);
  return source.slice(start, end);
}

describe("eaa.aeskeys — no longer self-caches", () => {
  it("does not contain the removed in-memory _aesKeyCache", () => {
    const source = getSource();
    expect(source).not.toContain("_aesKeyCache");
    expect(source).not.toContain("_AES_CACHE_MAX");
  });

  it("aeskeys() is a pure derivation with no cache lookup/store", () => {
    const source = getSource();
    const fn = extractFunction(source, "aeskeys: function (time: number, block: number, usersIds: string[] | null, v: number) {");
    expect(fn).not.toMatch(/cache/i);
  });
});

describe("aeskeysls — persistent, membership-aware AES-key cache", () => {
  it("exists as an async function distinct from the raw eaa.aeskeys", () => {
    const source = getSource();
    expect(source).toMatch(/async function aeskeysls\(/);
  });

  it("keys the cache on orderedIdsHash(usersIds) when an explicit list is given, period(_time) otherwise — never a bare/constant tuple", () => {
    const source = getSource();
    const start = source.indexOf("async function aeskeysls(");
    expect(start).toBeGreaterThan(-1);
    const end = source.indexOf("\n    }\n", start);
    const fn = source.slice(start, end);

    expect(fn).toMatch(/orderedIdsHash\(usersIds\)/);
    expect(fn).toMatch(/period\(_time\)/);
    // The degenerate pattern this regression guards against: falling back to
    // an empty string / constant when usersIds is null.
    expect(fn).not.toMatch(/usersIds\s*\?\s*usersIds\.join\(","\)\s*:\s*""/);
  });

  it("persists derived keys through pcrypto.ls (IndexedDB), not an in-memory Map", () => {
    const source = getSource();
    const start = source.indexOf("async function aeskeysls(");
    const end = source.indexOf("\n    }\n", start);
    const fn = source.slice(start, end);

    expect(fn).toMatch(/pcrypto\.ls\?\.get\(/);
    expect(fn).toMatch(/pcrypto\.ls\?\.set\(/);
  });
});

describe("period — cache-key component tied to member event history", () => {
  it("recomputes from getuserseventshistory() on every call (no memoization of the history itself)", () => {
    const source = getSource();
    const start = source.indexOf("function period(time: number): number {");
    expect(start).toBeGreaterThan(-1);
    const end = source.indexOf("\n    }\n", start);
    const fn = source.slice(start, end);

    expect(fn).toContain("getuserseventshistory()");
  });
});

describe("orderedIdsHash — order-independent hash of an explicit user list", () => {
  it("sorts numerically before hashing so caller-supplied order never changes the key", () => {
    const source = getSource();
    const start = source.indexOf("function orderedIdsHash(ids: string[]): string {");
    expect(start).toBeGreaterThan(-1);
    const end = source.indexOf("\n    }\n", start);
    const fn = source.slice(start, end);

    expect(fn).toMatch(/\.sort\(/);
    expect(fn).toMatch(/md5\(/);
  });
});

describe("_decrypt / _encrypt main-thread fallback — use aeskeysls, evict on failure", () => {
  it("_decrypt calls aeskeysls() instead of eaa.aeskeys() directly", () => {
    const source = getSource();
    const fn = extractFunction(source, "async _decrypt(");
    expect(fn).toMatch(/await aeskeysls\(/);
    expect(fn).not.toMatch(/eaa\.aeskeys\(/);
  });

  it("_decrypt clears the persistent cache entry on a decrypt failure and on a missing key", () => {
    const source = getSource();
    const fn = extractFunction(source, "async _decrypt(");
    const clearCalls = fn.match(/pcrypto\.ls\?\.clear\(/g) ?? [];
    // One for the decrypt()-throws path, one for the "no key for this
    // recipient" path — matches original self.decrypt (pcrypto.js:547,
    // reached from both the catch block and the missing-key branch).
    expect(clearCalls.length).toBeGreaterThanOrEqual(2);
  });

  it("_encrypt calls aeskeysls() instead of eaa.aeskeys() directly", () => {
    const source = getSource();
    const fn = extractFunction(source, "async _encrypt(");
    expect(fn).toMatch(/await aeskeysls\(/);
    expect(fn).not.toMatch(/eaa\.aeskeys\(/);
  });

  it("_encrypt clears the persistent cache entry when there is no key for the recipient", () => {
    const source = getSource();
    const fn = extractFunction(source, "async _encrypt(");
    expect(fn).toMatch(/pcrypto\.ls\?\.clear\(/);
  });
});
