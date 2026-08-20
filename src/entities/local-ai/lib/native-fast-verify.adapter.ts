import type { FastVerifyPort } from "local-ai";
import { ModelDownloader } from "./model-download-plugin";

/**
 * `FastVerifyPort` backed by `ModelDownloadPlugin.kt`'s native `verify()` —
 * see that method's own doc comment for why this exists: the portable
 * `readChunks()`-through-the-Filesystem-bridge path `local-ai`'s
 * `checksum.ts` otherwise uses is fine for small files, but was confirmed
 * live (2026-08-19) to take on the order of TWO HOURS to verify a 2.3GB
 * model — each chunk round-trips the JS↔native bridge with its own base64
 * encode/decode on top. Reading the file directly and hashing with
 * `MessageDigest` natively (no bridge at all) takes low single-digit
 * seconds on real hardware instead.
 */
export class NativeFastVerifyAdapter implements FastVerifyPort {
  async sha256File(path: string, expectedHex: string, onProgress?: (bytesHashed: number) => void): Promise<boolean> {
    // A generated id, not the file path — mirrors ModelDownloadPlugin's
    // download-side events, and keeps this call's progress ticks
    // unambiguous even if something else were ever verifying concurrently.
    const id = `verify_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    let listenerHandle: { remove: () => void } | null = null;
    if (onProgress) {
      listenerHandle = await ModelDownloader.addListener("verifyProgress", (data) => {
        if (data.id !== id) return;
        onProgress(data.bytesHashed);
      });
    }
    try {
      const result = await ModelDownloader.verify({ id, path, expectedSha256: expectedHex });
      return result.valid;
    } finally {
      listenerHandle?.remove();
    }
  }
}
