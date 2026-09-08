import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

/**
 * Regression: worker-side decrypt failures never evicted the poisoned
 * derived-key cache entry (keyCache), unlike the already-fixed main-thread
 * fallback in matrix-crypto.ts's _decrypt (which mirrors the original
 * bastyon-chat pcrypto.js self.decrypt behavior — evict on failure so the
 * next attempt re-derives instead of repeatedly failing against the same
 * bad key). Concretely: schema.ts v19 documents a production incident where
 * an `aeskeys` cache-key collision caused messages to derive the WRONG AES
 * key, exhaust DecryptionWorker's MAX_ATTEMPTS, and land permanently in the
 * terminal "failed" bucket — requiring a one-time DB migration to recover.
 * Since isCryptoWorkerSupported() makes the Worker path the primary path in
 * production (the main-thread path is only a fallback for old WebViews),
 * the worker's own keyCache was the actual blast radius for that class of
 * incident, and it had no eviction at all.
 *
 * Source verification, following this directory's/matrix-crypto's established
 * convention for the crypto layer (see matrix-crypto-aeskeys-cache.test.ts):
 * the module runs inside a real Web Worker and pulls in miscreant + secp256k1
 * point arithmetic, which is impractical to drive end-to-end with fabricated
 * (non-matching) key material in a unit test — the interesting property here
 * is the *shape* of the eviction wiring, not the underlying crypto math.
 */
const getSource = (): string =>
  readFileSync(resolve(__dirname, "./crypto.worker.ts"), "utf-8");

describe("crypto.worker keyCache — evicts on decrypt failure", () => {
  it("defines evictCachedKeys using the exact same cache-key scheme as getCachedKeys", () => {
    const source = getSource();
    expect(source).toMatch(/function cacheKeyFor\(/);
    expect(source).toMatch(/function evictCachedKeys\(/);

    // Both getCachedKeys and evictCachedKeys must derive the cache key via
    // the same cacheKeyFor() helper — two independently-computed key
    // strings could silently drift and evict the wrong (or no) entry.
    const getCachedKeysBody = source.slice(
      source.indexOf("function getCachedKeys("),
      source.indexOf("function evictCachedKeys("),
    );
    expect(getCachedKeysBody).toMatch(/cacheKeyFor\(users, block\)/);

    const evictBody = source.slice(source.indexOf("function evictCachedKeys("));
    expect(evictBody).toMatch(/keyCache\.delete\(cacheKeyFor\(users, block\)\)/);
  });

  it("the decrypt message handler evicts the cache entry when aesSivDecrypt throws", () => {
    const source = getSource();
    const start = source.indexOf('case "decrypt": {');
    expect(start).toBeGreaterThan(-1);
    const end = source.indexOf('case "encrypt": {', start);
    const decryptCase = source.slice(start, end);

    // The decrypt attempt must be wrapped so a thrown error triggers eviction
    // BEFORE propagating to the outer handler (which reports it to the caller).
    expect(decryptCase).toMatch(/try\s*\{[\s\S]*aesSivDecrypt\([\s\S]*\}\s*catch/);
    expect(decryptCase).toMatch(/evictCachedKeys\(msg\.users, msg\.block\)/);
    // Eviction must happen INSIDE the catch, before the error is re-thrown —
    // not merely present somewhere later in the case block.
    const catchIdx = decryptCase.indexOf("catch");
    const evictIdx = decryptCase.indexOf("evictCachedKeys(msg.users, msg.block)");
    const rethrowIdx = decryptCase.indexOf("throw decryptErr");
    expect(catchIdx).toBeGreaterThan(-1);
    expect(evictIdx).toBeGreaterThan(catchIdx);
    expect(rethrowIdx).toBeGreaterThan(evictIdx);
  });
});
