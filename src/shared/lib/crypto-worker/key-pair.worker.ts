/** Web Worker: BIP39 mnemonic → seed (PBKDF2 2048 rounds) off the main thread.
 *
 *  Why: On Android 7 / Redmi Note 4 devices, mnemonicToSeedSync() blocks the
 *  main thread for >10s during login-by-mnemonic. The ANR watchdog kills the
 *  WebView and the user sees "приватный ключ инвалид".
 *
 *  Implementation: uses the browser Web Crypto API (crypto.subtle.deriveBits)
 *  which runs natively in the UA and is 10x faster than a JS PBKDF2 polyfill
 *  while remaining non-blocking. This is the standard BIP39 derivation:
 *
 *      seed = PBKDF2-HMAC-SHA512(mnemonic.NFKD, "mnemonic" + passphrase, 2048, 64 bytes)
 *
 *  The worker responds with `{ seed: string }` (hex) or `{ error: string }`.
 *  The main thread then does the cheap bip32.fromSeed / derivePath / WIF work
 *  where the `bitcoin` global is available.
 *
 *  This worker intentionally has no npm dependencies — it only uses Web Crypto
 *  which is available in all modern WebView/browser contexts. The legacy
 *  synchronous path (bitcoin.bip39.mnemonicToSeedSync) remains as a fallback
 *  in key-pair-async.ts for contexts where Worker is unavailable.
 */

export interface KeyPairWorkerRequest {
  mnemonic: string;
  passphrase?: string;
}

export interface KeyPairWorkerResponse {
  seed?: string;
  error?: string;
}

const HEX_CHARS = "0123456789abcdef";
function bufferToHex(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    hex += HEX_CHARS[b >>> 4] + HEX_CHARS[b & 0x0f];
  }
  return hex;
}

/** BIP39 seed derivation via Web Crypto. Mirrors bip39.mnemonicToSeedSync.
 *  Same output as `bitcoin.bip39.mnemonicToSeedSync(mnemonic)` for the empty
 *  passphrase case — verified against BIP39 test vectors. */
async function mnemonicToSeedSync(
  mnemonic: string,
  passphrase = "",
): Promise<string> {
  const encoder = new TextEncoder();
  const mnemonicBytes = encoder.encode(mnemonic.normalize("NFKD"));
  const saltBytes = encoder.encode(("mnemonic" + passphrase).normalize("NFKD"));

  const key = await crypto.subtle.importKey(
    "raw",
    mnemonicBytes,
    { name: "PBKDF2" },
    false,
    ["deriveBits"],
  );
  const seed = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: saltBytes,
      iterations: 2048,
      hash: "SHA-512",
    },
    key,
    512, // 64 bytes * 8 bits
  );
  return bufferToHex(seed);
}

self.addEventListener("message", async (e: MessageEvent<KeyPairWorkerRequest>) => {
  try {
    const { mnemonic, passphrase } = e.data;
    if (!mnemonic || typeof mnemonic !== "string") {
      (self as unknown as Worker).postMessage({
        error: "invalid mnemonic",
      } satisfies KeyPairWorkerResponse);
      return;
    }
    const seed = await mnemonicToSeedSync(mnemonic, passphrase);
    (self as unknown as Worker).postMessage({
      seed,
    } satisfies KeyPairWorkerResponse);
  } catch (err) {
    (self as unknown as Worker).postMessage({
      error: err instanceof Error ? err.message : String(err),
    } satisfies KeyPairWorkerResponse);
  }
});

export {};
