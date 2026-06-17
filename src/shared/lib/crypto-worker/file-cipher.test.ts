import { describe, it, expect } from "vitest";
import {
  FILE_CIPHER_IV,
  encryptFileBuffer,
  decryptFileBuffer,
  resolveDecryptedMime,
} from "./file-cipher";

/**
 * WEE-92 — file-cipher is the single source of truth for the attachment
 * format, shared by the main thread (PcryptoFile) and the crypto Web Worker.
 * These tests pin the format: IV bytes, PBKDF2 round-trip, and wrong-key
 * failure mode. If any of this drifts, existing chats stop decrypting.
 */
describe("file-cipher (WEE-92)", () => {
  it("keeps the historical fixed IV byte-identical", () => {
    // Every attachment ever sent was encrypted with this IV — changing it
    // bricks all existing media.
    expect(Array.from(FILE_CIPHER_IV)).toEqual([
      19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34,
    ]);
  });

  it("round-trips bytes through encrypt → decrypt", async () => {
    const plain = new TextEncoder().encode("attachment bytes \u{1F4CE} тест");
    const secret = "1111,2222,3333";

    const encrypted = await encryptFileBuffer(plain.buffer.slice(0), secret);
    expect(new Uint8Array(encrypted)).not.toEqual(plain);

    const decrypted = await decryptFileBuffer(encrypted, secret);
    expect(new Uint8Array(decrypted)).toEqual(plain);
  });

  it("matches the golden ciphertext — pins salt, iterations, and IV together", async () => {
    // Generated with the production format (PBKDF2 "matrix.pocketnet" /
    // 10000 / SHA-256 → AES-CBC-256, fixed IV). A round-trip test alone
    // passes even if both sides drift together; this vector does not.
    const expected = new Uint8Array([
      21, 73, 180, 34, 65, 65, 214, 21, 50, 171, 111, 49, 40, 142, 173, 62,
      48, 67, 188, 27, 193, 154, 33, 7, 230, 17, 114, 47, 16, 239, 175, 145,
    ]);
    const ct = await encryptFileBuffer(
      new TextEncoder().encode("golden plaintext").buffer as ArrayBuffer,
      "golden-secret",
    );
    expect(new Uint8Array(ct)).toEqual(expected);

    const pt = await decryptFileBuffer(expected.buffer.slice(0), "golden-secret");
    expect(new TextDecoder().decode(pt)).toBe("golden plaintext");
  });

  it("rejects on a wrong secret (deterministic crypto failure)", async () => {
    const plain = new TextEncoder().encode("payload");
    const encrypted = await encryptFileBuffer(plain.buffer.slice(0), "right-key");
    await expect(decryptFileBuffer(encrypted, "wrong-key")).rejects.toBeDefined();
  });

  describe("resolveDecryptedMime", () => {
    it("prefers the declared original MIME", () => {
      expect(resolveDecryptedMime("application/octet-stream", "image/jpeg")).toBe("image/jpeg");
    });

    it("strips the legacy encrypted/ prefix when no original MIME", () => {
      expect(resolveDecryptedMime("encrypted/video/mp4")).toBe("video/mp4");
    });

    it("falls back to octet-stream", () => {
      expect(resolveDecryptedMime("application/octet-stream")).toBe("application/octet-stream");
      expect(resolveDecryptedMime("")).toBe("application/octet-stream");
    });
  });
});
