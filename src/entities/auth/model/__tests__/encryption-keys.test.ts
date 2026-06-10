import { describe, it, expect, beforeEach, vi } from "vitest";
import { generateEncryptionKeys, clearEncryptionKeysCache } from "../encryption-keys";

// Deterministic stub of the global `bitcoin` SDK object: derivation output is
// a pure function of (seed, path) so cache hits can be compared to fresh runs.
const fromSeedSpy = vi.fn((seed: Buffer) => ({
  derivePath: (path: string) => {
    const material = Buffer.from(`${seed.toString("hex")}:${path}`);
    return { privateKey: material, publicKey: material };
  },
}));

(globalThis as unknown as { bitcoin: unknown }).bitcoin = {
  bip32: { fromSeed: fromSeedSpy },
  ECPair: { fromPrivateKey: (k: Buffer) => ({ priv: k }) },
};

const KEY_A = "aa".repeat(32);
const KEY_B = "bb".repeat(32);

describe("generateEncryptionKeys cache (WEE-97 item 5)", () => {
  beforeEach(() => {
    clearEncryptionKeysCache();
    fromSeedSpy.mockClear();
  });

  it("derives 12 keys at m/33'/0'/0'/{1-12}'", () => {
    const keys = generateEncryptionKeys(KEY_A);
    expect(keys).toHaveLength(12);
    expect(keys[0].public).toBe(
      Buffer.from(`${KEY_A}:m/33'/0'/0'/1'`).toString("hex"),
    );
    expect(keys[11].public).toBe(
      Buffer.from(`${KEY_A}:m/33'/0'/0'/12'`).toString("hex"),
    );
  });

  it("A3: cached keys are identical to freshly derived ones", () => {
    const fresh = generateEncryptionKeys(KEY_A);
    const cached = generateEncryptionKeys(KEY_A);

    // Same object — and therefore byte-for-byte identical to the derivation
    expect(cached).toBe(fresh);
    expect(cached.map((k) => k.public)).toEqual(fresh.map((k) => k.public));
    // The expensive BIP32 derivation ran exactly once
    expect(fromSeedSpy).toHaveBeenCalledTimes(1);
  });

  it("re-derives when the private key changes (account switch)", () => {
    const keysA = generateEncryptionKeys(KEY_A);
    const keysB = generateEncryptionKeys(KEY_B);

    expect(fromSeedSpy).toHaveBeenCalledTimes(2);
    expect(keysB[0].public).not.toBe(keysA[0].public);

    // Switching back also re-derives (single-entry cache holds only the active account)
    generateEncryptionKeys(KEY_A);
    expect(fromSeedSpy).toHaveBeenCalledTimes(3);
  });

  it("clearEncryptionKeysCache drops the memoized material", () => {
    generateEncryptionKeys(KEY_A);
    clearEncryptionKeysCache();
    generateEncryptionKeys(KEY_A);
    expect(fromSeedSpy).toHaveBeenCalledTimes(2);
  });
});
