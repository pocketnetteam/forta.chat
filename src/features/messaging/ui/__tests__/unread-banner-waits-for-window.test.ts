import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Audit W2C-02: with more unread messages than the default window, opening the
 * chat looked for the unread banner two ticks later, did not find it and
 * dropped to the newest message. The first fix waited 500 ms for the window
 * expansion; on a real phone (Samsung, 2026-10-10, 72 unread) the messages
 * were still landing from Dexie after that and the chat still opened at the
 * bottom. The scroll now waits for the banner row itself, a few seconds at
 * most, and leaves a user who already scrolled alone.
 * Source-level: MessageList needs the whole chat stack to mount.
 */
const source = readFileSync(resolve(__dirname, "../MessageList.vue"), "utf-8");
const fallback = source.slice(source.indexOf("// The banner row is not in the list yet"));

describe("MessageList — scroll to the unread banner", () => {
  it("still starts the expansion that brings the banner in", () => {
    expect(source).toContain("void chatStore.expandMessageWindow(neededWindow - chatStore.messageWindowSize);");
  });

  it("waits for the banner row, not a fixed 500 ms", () => {
    expect(source).toMatch(/const BANNER_ROW_WAIT_MS = 3000;/);
    expect(source).not.toContain("BANNER_WINDOW_WAIT_MS");
    const helper = source.slice(source.indexOf("const waitForBannerRow ="), source.indexOf("const waitForBannerRow =") + 500);
    expect(helper).toContain("watch(bannerIdx,");
    expect(fallback).toMatch(/void waitForBannerRow\(BANNER_ROW_WAIT_MS\)\.then\(async \(idx\) => \{\s*if \(isStale\(\) \|\| idx < 0\) return;/);
    expect(fallback).toMatch(/if \(fresh >= 0\) scrollToBannerRow\(fresh\);/);
  });

  it("shows the newest meanwhile and leaves a user who already scrolled alone (batch-6 review)", () => {
    expect(fallback.indexOf("if (el) el.scrollTop = 0;")).toBeLessThan(fallback.indexOf("const scrollAtOpen = el?.scrollTop ?? 0;"));
    expect(fallback).toMatch(/if \(now && Math\.abs\(now\.scrollTop - scrollAtOpen\) > 2\) return;/);
  });

  // Samsung, 2026-10-10: the view reached the banner and 40 ms later went back
  // to the newest message. The first messages landing during the open queued
  // scrollToBottom(), and while it settled the content-resize observer pulled
  // the view down; isNearBottom also still held "bottom" from the room switch.
  it("drops a pending scroll to the newest and refreshes the bottom flag when it scrolls to the banner", () => {
    const helper = source.slice(source.indexOf("const scrollToBannerRow ="), source.indexOf("const scrollToBannerRow =") + 300);
    expect(helper).toMatch(/cancelScrollToBottom\(\);\s*scrollerRef\.value\?\.scrollToIndex\(reversedIdx, \{ align: "start" \}\);\s*checkScroll\(\);/);
    expect(source).toContain("if (reversedIdx >= 0) scrollToBannerRow(reversedIdx);");
    // Only the helper scrolls to the banner during the open.
    const phase3 = source.slice(source.indexOf("// ═══ PHASE 3"), source.indexOf("// ═══ PHASE 4"));
    expect(phase3).not.toContain("scrollToIndex(");
  });

  it("a cancelled scroll to the newest no longer moves the view or holds the pending flag", () => {
    const cancel = source.slice(source.indexOf("const cancelScrollToBottom ="), source.indexOf("const cancelScrollToBottom =") + 200);
    expect(cancel).toMatch(/scrollToBottomGen\+\+;\s*clearTimeout\(scrollStableTimer\);\s*pendingScrollToBottom = false;/);
    const toBottom = source.slice(source.indexOf("const scrollToBottom = ("), source.indexOf("const cancelScrollToBottom ="));
    expect(toBottom).toContain("const gen = ++scrollToBottomGen;");
    expect(toBottom.match(/if \(gen !== scrollToBottomGen\) return;/g)).toHaveLength(2);
  });

  // Review 2026-10-10: an own send during the wait keeps scrollTop at 0, so the
  // "user scrolled" guard missed it and the banner scroll pulled the view up
  // from the message just sent.
  it("skips the delayed banner scroll after an own send", () => {
    expect(fallback).toMatch(/const ownAppendsAtOpen = ownAppendCount;/);
    expect(fallback).toMatch(/if \(ownAppendCount !== ownAppendsAtOpen\) return;/);
    expect(source).toMatch(/const lastAddedIsOwn = lastMsg\.senderId === authStore\.address;\s*if \(lastAddedIsOwn\) ownAppendCount\+\+;/);
  });
});
