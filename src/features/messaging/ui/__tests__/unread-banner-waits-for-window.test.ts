import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Audit W2C-02: with more unread messages than the default window, opening the
 * chat started the window expansion without waiting for it, looked for the
 * unread banner two ticks later, did not find it and dropped to the newest
 * message. The first scroll now waits (briefly) for that expansion and retries.
 * Source-level: MessageList needs the whole chat stack to mount.
 */
const source = readFileSync(resolve(__dirname, "../MessageList.vue"), "utf-8");

describe("MessageList — scroll to the unread banner", () => {
  it("keeps the expansion that brings the banner in", () => {
    expect(source).toContain(
      "bannerWindowExpand = chatStore.expandMessageWindow(neededWindow - chatStore.messageWindowSize);",
    );
    expect(source).not.toContain("void chatStore.expandMessageWindow(neededWindow - chatStore.messageWindowSize);");
  });

  it("waits a bounded time for it before falling back to the newest message", () => {
    expect(source).toMatch(/const BANNER_WINDOW_WAIT_MS = 500;/);
    expect(source).toMatch(/Promise\.race\(\[expand\.catch\(\(\) => false\), new Promise\(\(r\) => setTimeout\(r, BANNER_WINDOW_WAIT_MS\)\)\]\)/);
    const retry = source.slice(source.indexOf("} else if (bannerWindowExpand) {"));
    expect(retry).toMatch(/void waitForBannerWindow\(expand\)\.then\(async \(\) => \{\s*if \(isStale\(\)\) return;/);
    expect(retry).toMatch(/scrollerRef\.value\?\.scrollToIndex\(idx, \{ align: "start" \}\)/);
  });

  it("leaves a user who already scrolled alone (batch-6 review)", () => {
    const retry = source.slice(source.indexOf("} else if (bannerWindowExpand) {"));
    expect(retry).toContain("const scrollAtOpen = el?.scrollTop ?? 0;");
    expect(retry).toMatch(/if \(now && Math\.abs\(now\.scrollTop - scrollAtOpen\) > 2\) return;/);
  });
});
