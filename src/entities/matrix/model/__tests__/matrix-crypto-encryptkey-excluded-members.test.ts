import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

/**
 * Regression: room.encryptKey() (used by both sendCommonKey() for group text
 * messages and encryptFile() for attachments) wraps the shared secret only
 * for preparedUsers() — a list that SILENTLY drops any member whose derived
 * key set is short (ui.keys.length < m). A member excluded this way used to
 * receive no warning anywhere: no exception, no log, nothing — they simply
 * get a message/file they can never decrypt. This is a real, not
 * hypothetical, class of incident: entities/auth/model/stores.ts's
 * getUsersInfo has an explicit fallback for the Pocketnet RPC returning a
 * partial key set (documented as a `filterXSS` truncation bug).
 *
 * Fix: encryptKey() now diagnoses the gap between all known room members
 * and the prepared-for-encryption subset, and logs the excluded ids. This
 * does not change what gets sent (no behavior change for callers) — it only
 * makes an otherwise-silent "why can't X read this chat" failure traceable.
 *
 * Source-level regression, following this directory's established
 * convention for matrix-crypto.ts (see matrix-crypto-aeskeys-cache.test.ts):
 * the module pulls in miscreant + WebCrypto + IndexedDB and is impractical
 * to unit-test end-to-end without an extensive harness.
 */
const getSource = (): string =>
  readFileSync(resolve(__dirname, "../matrix-crypto.ts"), "utf-8");

function extractEncryptKey(source: string): string {
  const start = source.indexOf("async encryptKey(key: string)");
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf("\n      },", start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("pcrypto room.encryptKey — warns about members excluded for incomplete keys", () => {
  it("computes the excluded-member set as (all known users) minus (preparedUsers)", () => {
    const source = getSource();
    const fn = extractEncryptKey(source);

    expect(fn).toMatch(/preparedIds = new Set\(_users\.map/);
    expect(fn).toMatch(/excludedMemberIds = Object\.keys\(users\)\.filter/);
  });

  it("logs a warning listing the excluded member ids, without throwing or changing the return value", () => {
    const source = getSource();
    const fn = extractEncryptKey(source);

    expect(fn).toMatch(/console\.warn\(/);
    expect(fn).toMatch(/excludedMemberIds/);
    // No throw introduced — the diagnostic must not change control flow.
    expect(fn).not.toMatch(/throw new Error/);
    // The function must still return the same shape as before the fix.
    expect(fn).toMatch(/return \{\s*block,\s*keys: Base64\.encode\(JSON\.stringify\(encrypted\)\),\s*v: version\s*\};/);
  });

  it("the diagnostic runs before the encrypted-map loop (doesn't depend on its result)", () => {
    const source = getSource();
    const fn = extractEncryptKey(source);

    const warnIdx = fn.indexOf("console.warn(");
    const loopIdx = fn.indexOf("for (let i = 0; i < _users.length; i++)");
    expect(warnIdx).toBeGreaterThan(-1);
    expect(loopIdx).toBeGreaterThan(-1);
    expect(warnIdx).toBeLessThan(loopIdx);
  });
});
