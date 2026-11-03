import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Audit S3-01: incoming messages and reactions wait 150/500 ms in the event
 * writer's buffers, which were flushed only on a room switch or logout — an app
 * closed in that window lost them. Source-level, like the other chat-store
 * wiring tests: the store needs the SDK to run.
 */
const source = readFileSync(resolve(__dirname, "../chat-store.ts"), "utf-8");

describe("chat-store flushes incoming writes when the app goes to the background", () => {
  it("defines one flush that never throws", () => {
    expect(source).toMatch(
      /const flushIncomingWrites = \(\) => \{\s*chatDbKitRef\.value\?\.eventWriter\.flushWriteBuffer\(\)\.catch\(/,
    );
  });

  it("flushes on a hidden page, on pagehide and when the native app goes inactive", () => {
    expect(source).toMatch(/if \(document\.visibilityState === "hidden"\) flushIncomingWrites\(\);/);
    expect(source).toContain('window.addEventListener("pagehide", flushIncomingWrites);');
    expect(source).toMatch(/syncAllUnreadFromMatrix\(\);\s*\} else \{\s*flushIncomingWrites\(\);/);
  });
});
