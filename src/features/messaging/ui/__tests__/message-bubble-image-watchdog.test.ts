import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

/**
 * Regression for WEE-90 H3 (images spin forever).
 *
 * The image placeholder shows a spinner while there is no preview and no
 * error — including the neutral "not started" window. Before the fix a stalled
 * download (a path the lower-level timeouts didn't catch) left that spinner
 * spinning forever with no recourse. The image-load watchdog mirrors the video
 * watchdog (WEE-21): after a deadline it flips to the error+retry overlay so
 * the spinner is always finite.
 *
 * Crucially the deadline must measure DOWNLOAD time, not MOUNT time:
 * ChatVirtualScroller mounts every row eagerly but the encrypted-image download
 * only fires once the bubble scrolls into view, so the watchdog is gated on
 * `imageInViewport` — otherwise off-screen images would falsely time out.
 *
 * Source-level assertions keep the surface focused without mounting the
 * 1k-line MessageBubble.vue + its store mocks (same pattern as the video
 * watchdog regression test).
 */
const getSource = (): string =>
  readFileSync(resolve(__dirname, "../MessageBubble.vue"), "utf-8");

describe("MessageBubble — image spinner watchdog (WEE-90 H3)", () => {
  it("tracks the timeout in a reactive `imageLoadTimedOut` ref", () => {
    const source = getSource();
    expect(source).toMatch(/imageLoadTimedOut\s*=\s*ref\(false\)/);
  });

  it("arms a load timeout using the IMAGE_LOAD_TIMEOUT_MS constant", () => {
    const source = getSource();
    expect(source).toContain("IMAGE_LOAD_TIMEOUT_MS");
    expect(source).toMatch(/setTimeout\([\s\S]*?IMAGE_LOAD_TIMEOUT_MS\s*\)/);
  });

  it("gates the watchdog on viewport visibility so off-screen images don't false-fail", () => {
    const source = getSource();
    const start = source.indexOf("const imageSpinnerActive");
    expect(start, "imageSpinnerActive must exist").toBeGreaterThan(-1);
    const end = source.indexOf(");", start);
    const block = source.slice(start, end);
    // The download is gated on imageInViewport; the watchdog must use the same
    // gate so the deadline measures download time, not mount time.
    expect(block).toContain("imageInViewport");
  });

  it("guards the timeout write so a late objectUrl/error isn't clobbered", () => {
    const source = getSource();
    const start = source.indexOf("const syncImageLoadWatchdog");
    expect(start, "syncImageLoadWatchdog must exist").toBeGreaterThan(-1);
    const end = source.indexOf("};", start);
    const block = source.slice(start, end);
    // Re-check live state inside the timer before flipping to timed-out.
    expect(block).toMatch(/if\s*\(imageSpinnerActive\.value\)\s*imageLoadTimedOut\.value\s*=\s*true/);
  });

  it("hides the spinner and shows the error overlay once timed out", () => {
    const source = getSource();
    // Spinner v-if must exclude the timed-out state.
    expect(source).toMatch(/v-if="!feedImageSrc && !imageLoadTimedOut/);
    // The generic error+retry overlay must also render on watchdog timeout.
    expect(source).toMatch(/v-else-if="fileState\.error \|\| imageLoadTimedOut"/);
  });

  it("retry resets the watchdog and forces a fresh fetch", () => {
    const source = getSource();
    const start = source.indexOf("const retryDownload");
    expect(start).toBeGreaterThan(-1);
    const end = source.indexOf("};", start);
    const block = source.slice(start, end);
    expect(block).toContain("imageLoadTimedOut.value = false");
    expect(block).toContain("clearImageLoadTimer()");
    expect(block).toMatch(/forceRefetch:\s*true/);
  });

  it("resets the watchdog when the bubble is recycled to a new message", () => {
    const source = getSource().replace(/\r\n/g, "\n");
    // Walk the dedicated id-watch that resets the watchdog state.
    const idx = source.indexOf("watch(\n  () => props.message.id,\n  () => {\n    imageLoadTimedOut.value = false;");
    const idxAlt = source.indexOf("imageLoadTimedOut.value = false;\n    clearImageLoadTimer();\n    syncImageLoadWatchdog();");
    const resolvedIdx = idx >= 0 ? idx : idxAlt;
    expect(resolvedIdx, "id-watch must reset + re-arm the image watchdog").toBeGreaterThan(-1);
  });

  it("clears the load timer on unmount to avoid late writes to a dead ref", () => {
    const source = getSource();
    expect(source).toContain("onBeforeUnmount(clearImageLoadTimer)");
  });
});
