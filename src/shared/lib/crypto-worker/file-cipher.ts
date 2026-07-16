/**
 * Pure PBKDF2 + AES-CBC file cipher — the single source of truth for the
 * file-attachment encryption format (a direct port of bastyon-chat's
 * PcryptoFile, see matrix-crypto.ts).
 *
 * Shared by the main thread (PcryptoFile) and the crypto Web Worker
 * (decryptFile operation) so the two paths can never drift apart on IV,
 * salt, iteration count, or key length. No DOM, no Vue — safe to import
 * from a Worker context.
 */

/** Fixed IV — must stay byte-identical to historical PcryptoFile ciphertexts;
 *  every existing attachment in every chat was encrypted with it. */
export const FILE_CIPHER_IV = new Uint8Array([
  19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34,
]);

const PBKDF2_SALT = "matrix.pocketnet";
const PBKDF2_ITERATIONS = 10000;

/** Safe accessor for crypto.subtle — throws a clear error instead of a
 *  cryptic 'undefined' when the context is insecure (plain HTTP). Works in
 *  both window and Worker scopes via globalThis. */
function getSubtle(): SubtleCrypto {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error(
      "crypto.subtle is unavailable (requires HTTPS or localhost). " +
      "Serve the app over HTTPS to enable encryption.",
    );
  }
  return subtle;
}

/** Derive the AES-CBC key from the per-file secret string. */
export async function deriveFileKey(secret: string): Promise<CryptoKey> {
  const subtle = getSubtle();
  const enc = new TextEncoder();
  const keyMaterial = await subtle.importKey(
    "raw",
    enc.encode(secret),
    "PBKDF2",
    false,
    ["deriveBits", "deriveKey"],
  );
  return subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: enc.encode(PBKDF2_SALT),
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: "AES-CBC", length: 256 },
    true,
    ["encrypt", "decrypt"],
  );
}

/** Encrypt plaintext bytes with the per-file secret. */
export async function encryptFileBuffer(
  data: ArrayBuffer,
  secret: string,
): Promise<ArrayBuffer> {
  const key = await deriveFileKey(secret);
  return getSubtle().encrypt({ name: "AES-CBC", iv: FILE_CIPHER_IV }, key, data);
}

/** Decrypt ciphertext bytes with the per-file secret. Rejects (typically
 *  with a DOMException OperationError) when the secret is wrong or the
 *  ciphertext is corrupted. */
export async function decryptFileBuffer(
  data: ArrayBuffer,
  secret: string,
): Promise<ArrayBuffer> {
  const key = await deriveFileKey(secret);
  return getSubtle().decrypt({ name: "AES-CBC", iv: FILE_CIPHER_IV }, key, data);
}

/** Resolve the plaintext MIME for a decrypted attachment. New writers store
 *  ciphertext as application/octet-stream and carry the real MIME in
 *  fileInfo.type (`originalMime`); old clients used a legacy
 *  "encrypted/<mime>" pseudo-type on the ciphertext blob itself. */
export function resolveDecryptedMime(
  ciphertextType: string,
  originalMime?: string,
): string {
  if (originalMime) return originalMime;
  if (ciphertextType.startsWith("encrypted/")) {
    return ciphertextType.replace("encrypted/", "");
  }
  return "application/octet-stream";
}
