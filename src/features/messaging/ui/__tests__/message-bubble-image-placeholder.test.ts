import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const source = readFileSync(
  resolve(__dirname, "../MessageBubble.vue"),
  "utf-8",
);

/**
 * WEE-91 — regression of WEE-71 (thumbnail-first). A server-thumbnail URL
 * resolves synchronously, so `feedImageSrc` is truthy before the browser has
 * fetched the image. The old spinner gated on `!feedImageSrc`, so it was
 * skipped and the bare `<img>` showed its `alt` (the filename "img1.png")
 * until `@load`, looking like a broken image.
 *
 * Fix: track per-image load state, keep a placeholder over the `<img>` until
 * it paints, and stop rendering the filename as visible `alt` content.
 */
describe("MessageBubble — image placeholder until @load (WEE-91)", () => {
  it("tracks per-image load state with an `imageLoaded` ref", () => {
    expect(source).toMatch(/const imageLoaded = ref\(false\)/);
  });

  it("flips `imageLoaded` true on the <img> @load handler", () => {
    expect(source).toMatch(/@load="imageLoaded = true; emit\('resize'\)"/);
  });

  it("resets `imageLoaded` when the source changes (thumbnail→full fallback)", () => {
    // A watch on feedImageSrc resets the flag so a swapped source re-shows
    // the placeholder until the new image paints.
    expect(source).toMatch(/watch\(feedImageSrc,[\s\S]*?imageLoaded\.value = false/);
  });

  it("resets `imageLoaded` when the bubble is recycled for a different message", () => {
    // Virtual scroller reuses the instance — without the reset a loaded image
    // would suppress the placeholder for the next (still-loading) message.
    expect(source).toMatch(/watch\(\(\) => props\.message\.id[\s\S]*?imageLoaded\.value = false/);
  });

  it("gates the placeholder on src-present-but-not-loaded, excluding error states", () => {
    expect(source).toMatch(/const showImagePlaceholder = computed/);
    expect(source).toMatch(/!!feedImageSrc\.value/);
    expect(source).toMatch(/!imageLoaded\.value/);
    expect(source).toMatch(/!fileState\.value\.error/);
    expect(source).toMatch(/!imageDecodeFailed\.value/);
  });

  it("renders a sized placeholder overlay while the image loads", () => {
    expect(source).toMatch(/v-if="showImagePlaceholder"[\s\S]*?:style="imagePlaceholderStyle"/);
    // Spinner inside the overlay.
    expect(source).toMatch(/v-if="showImagePlaceholder"[\s\S]*?animate-spin/);
  });

  it("does not render the filename as visible alt content on the feed <img>", () => {
    // The feed image uses an empty alt so the filename ("img1.png") never
    // shows while the image is still loading.
    expect(source).toMatch(/<img v-else-if="feedImageSrc"[^>]*\salt=""/);
    expect(source).not.toMatch(/<img v-else-if="feedImageSrc"[^>]*:alt="message\.fileInfo\?\.name"/);
  });

  it("keeps the thumbnail-first @error recovery intact (WEE-71)", () => {
    // A3/A4: error fallback (full-size recovery + decode-fail placeholder)
    // must still be wired.
    expect(source).toMatch(/@error="onFeedImageError"/);
  });
});
