// ---------------------------------------------------------------------------
// Pcrypto encryption-key derivation (WEE-97 item 5)
//
// Derives 12 BIP32 key pairs at m/33'/0'/0'/{1-12}' from the account private
// key — CPU-bound work on the main thread (~50-100ms on mid-range Android).
// Memoized per private key: the derivation is deterministic, so re-deriving
// on every initMatrix / profile read is pure waste. The cache holds exactly
// one entry (the active account) and lives only in module memory — the same
// exposure level as the private key itself, which SessionManager already
// keeps in memory/localStorage.
// ---------------------------------------------------------------------------

/* eslint-disable @typescript-eslint/no-explicit-any */
declare const bitcoin: any;

export interface EncryptionKeyPair {
  pair: unknown;
  public: string;
  private: Buffer;
}

let _cache: { privateKeyHex: string; keys: EncryptionKeyPair[] } | null = null;

/** Generate 12 BIP32 key pairs at m/33'/0'/0'/{1-12}' for Pcrypto encryption.
 *  Matches original: bitcoin.bip32.fromSeed(Buffer.from(privateKey, "hex")) */
export function generateEncryptionKeys(privateKeyHex: string): EncryptionKeyPair[] {
  if (_cache && _cache.privateKeyHex === privateKeyHex) {
    return _cache.keys;
  }

  const key = Buffer.from(privateKeyHex, "hex");
  const root = bitcoin.bip32.fromSeed(key);

  const keys: EncryptionKeyPair[] = [];
  for (let i = 1; i <= 12; i++) {
    const child = root.derivePath(`m/33'/0'/0'/${i}'`);
    keys.push({
      pair: bitcoin.ECPair.fromPrivateKey(child.privateKey),
      public: child.publicKey.toString("hex"),
      private: child.privateKey,
    });
  }

  // Freeze the cached array (shallow) — a caller mutating it would otherwise
  // poison the cache for the rest of the session. Callers only read/.map().
  Object.freeze(keys);
  _cache = { privateKeyHex, keys };
  return keys;
}

/** Drop cached key material (logout / account removal). */
export function clearEncryptionKeysCache(): void {
  _cache = null;
}
