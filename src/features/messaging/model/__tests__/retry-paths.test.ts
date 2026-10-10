import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";

/**
 * Audit batch-2 review of use-messages.ts retry paths.
 * - The per-message Retry did nothing for media while the Matrix client was not
 *   ready, and flipped a text straight back to failed — exactly during the
 *   outage after which S2-01 marks messages failed. Both now re-queue the
 *   message's own failed op (SyncEngine.retryFailedFor), and SyncEngine waits
 *   for the client itself; a new op next to the failed one also sent the text
 *   twice once the old op was retried.
 * - The direct media-retry pipeline uploaded and sent the file in the clear
 *   whenever canBeEncrypt() was false, bypassing SyncEngine's private-room
 *   guard. Source-level: these paths need Dexie, Pcrypto and Matrix to run.
 */
const source = readFileSync(resolve(__dirname, "../use-messages.ts"), "utf-8");

function body(name: string): string {
  const start = source.indexOf(`const ${name} = async (`);
  expect(start, `${name} not found`).toBeGreaterThan(-1);
  return source.slice(start, source.indexOf("\n  };", start));
}

describe("use-messages retry paths", () => {
  it("text retry re-queues the failed op and has no readiness gate", () => {
    const retry = body("retryMessage");
    expect(retry).toContain("await dbKit.syncEngine.retryFailedFor(mKey)");
    expect(retry).not.toContain("isReady()");
    expect(retry.indexOf("retryFailedFor(mKey)")).toBeLessThan(retry.indexOf('"send_message"'));
  });

  it("media retry re-queues the failed op before anything needs the client", () => {
    const retry = body("retryMediaUpload");
    const requeue = retry.indexOf("await dbKit.syncEngine.retryFailedFor(mKey)");
    const ready = retry.indexOf("if (!matrixService.isReady())");
    expect(requeue).toBeGreaterThan(-1);
    expect(ready).toBeGreaterThan(requeue);
  });

  it("media retry never sends a file in the clear to a private room", () => {
    const retry = body("retryMediaUpload");
    expect(retry).toMatch(/else if \(roomCrypto\?\.requiresEncryption\(\)\) \{[\s\S]*ENCRYPTION_REQUIRED_NO_KEYS/);
    expect(retry.indexOf("requiresEncryption()")).toBeLessThan(retry.indexOf("matrixService.uploadContent("));
  });
});
