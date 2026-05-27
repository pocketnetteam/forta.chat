import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const source = readFileSync(
  resolve(__dirname, "../MessageBubble.vue"),
  "utf-8",
);

/**
 * WEE-51 / forta-bugs#757, #743 — When the receiver gets a HEIC/HEIF image
 * from a sender that didn't transcode (older app build, native iOS Bastyon,
 * etc.), Android WebView fails to decode it and renders the broken-image
 * glyph at the natural image dimensions. That blew past the bubble's
 * `max-h-[460px]` cap and produced the "huge blurry preview" complaint.
 *
 * The fix wires `<img>`'s `@error` to a per-bubble `imageDecodeFailed` ref
 * and shows a sized placeholder with the filename instead — so a broken
 * HEIC stays inside the bubble box and gives the user a sane affordance.
 */
describe("MessageBubble — HEIC / broken-image fallback (WEE-51)", () => {
  it("declares an `imageDecodeFailed` ref", () => {
    expect(source).toMatch(/const imageDecodeFailed = ref\(false\)/);
  });

  it("wires <img>'s @error to flip the fallback flag", () => {
    expect(source).toMatch(/@error="imageDecodeFailed = true"/);
  });

  it("resets the fallback flag when the bubble is recycled for a different message", () => {
    // Virtual scroller recycles bubbles — without the reset, a previously
    // failed HEIC bubble would mask a perfectly good JPEG for the new message.
    expect(source).toMatch(/imageDecodeFailed\.value = false/);
  });

  it("renders a constrained placeholder when decode failed", () => {
    // The placeholder uses `imagePlaceholderStyle` so it stays inside the
    // bubble's max-h box — the whole point of the fix.
    expect(source).toMatch(/v-else-if="fileState\.objectUrl && imageDecodeFailed"[\s\S]*?:style="imagePlaceholderStyle"/);
  });

  it("computes an HEIC hint so the placeholder explains the cause when applicable", () => {
    expect(source).toMatch(/const isLikelyHeic = computed/);
    expect(source).toMatch(/heic\|heif/);
    expect(source).toMatch(/message\.heicNotSupported/);
  });
});
