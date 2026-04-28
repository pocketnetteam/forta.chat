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

  it("decryptFile honours originalMime argument when provided", async () => {
    const { PcryptoFile } = await import("../matrix-crypto");
    const pf = new PcryptoFile();
    const plaintext = new Uint8Array([1, 2, 3]);
    const input = new File([plaintext], "data.bin", { type: "image/png" });

    const encrypted = await pf.encryptFile(input, "mime-secret");
    // Ciphertext blob has application/octet-stream. Caller knows the real
    // mimetype from fileInfo.type and passes it explicitly.
    const decrypted = await pf.decryptFile(encrypted, "mime-secret", "image/png");

    expect(decrypted.type).toBe("image/png");
  }, TEST_TIMEOUT);

  it("decryptFile falls back to legacy encrypted/* prefix if originalMime omitted", async () => {
    const { PcryptoFile } = await import("../matrix-crypto");
    const pf = new PcryptoFile();
    // Simulate a blob written by the OLD client that stamped an invalid
    // compound MIME like encrypted/image/png. The decrypt must strip the
    // prefix so older messages still open.
    const blob = new Blob([new Uint8Array([1, 2])], { type: "encrypted/image/png" });
    // We only care about the MIME-restore logic here — use a stub key path
    // by piggybacking on a real encrypt/decrypt cycle.
    const realEncrypted = await pf.encryptFile(
      new File([new Uint8Array([99])], "x.png", { type: "image/png" }),
      "legacy-secret",
    );
    // Re-wrap the ciphertext bytes in a legacy-mime Blob
    const legacyShaped = new File([await realEncrypted.arrayBuffer()], "legacy", {
      type: "encrypted/image/png",
    });

    const decrypted = await pf.decryptFile(legacyShaped, "legacy-secret");
    // Without originalMime, the restored MIME must be the stripped form
    // (not "application/octet-stream" — that would regress older previews).
    expect(decrypted.type).toBe("image/png");

    // Touch the unused `blob` to keep the compiler honest.
    expect(blob.size).toBe(2);
  }, TEST_TIMEOUT);
});
