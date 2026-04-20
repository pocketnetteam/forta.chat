import { describe, it, expect } from "vitest";

// The PcryptoFile class encrypts file bytes with AES-CBC and wraps them
// in a File object. The old implementation used MIME "encrypted/<original>"
// which is NOT a valid RFC 2045 MIME and makes some homeserver proxies
// (nginx/cloudflare) return 415 Unsupported Media Type on upload.
//
// The fix: output a generic "application/octet-stream" for the ciphertext
// payload (original MIME is carried separately in the event's fileInfo.mimetype).

describe("PcryptoFile.encryptFile — MIME type", () => {
  // PBKDF2 with 10k iterations is slow in happy-dom; give the runner room.
  const TEST_TIMEOUT = 30_000;

  it("encrypted File uses application/octet-stream, not encrypted/<mime>", async () => {
    const { PcryptoFile } = await import("../matrix-crypto");
    const pf = new PcryptoFile();
    const input = new File([new Uint8Array([1, 2, 3, 4])], "photo.jpg", {
      type: "image/jpeg",
    });

    const encrypted = await pf.encryptFile(input, "test-secret");

    // Must be a valid RFC 2045 MIME
    expect(encrypted.type).toBe("application/octet-stream");
    // Must not leak the old invalid compound MIME
    expect(encrypted.type).not.toMatch(/^encrypted\//);
  }, TEST_TIMEOUT);

  it("decryptFile restores bytes regardless of encrypted MIME", async () => {
    const { PcryptoFile } = await import("../matrix-crypto");
    const pf = new PcryptoFile();
    const plaintext = new Uint8Array([10, 20, 30, 40, 50]);
    const input = new File([plaintext], "data.bin", { type: "image/jpeg" });

    const encrypted = await pf.encryptFile(input, "some-secret");
    const decrypted = await pf.decryptFile(encrypted, "some-secret");
    const bytes = new Uint8Array(await decrypted.arrayBuffer());

    expect(Array.from(bytes)).toEqual(Array.from(plaintext));
  }, TEST_TIMEOUT);
});
