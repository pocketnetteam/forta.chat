import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const source = readFileSync(
  resolve(__dirname, "../MessageBubble.vue"),
  "utf-8",
);
const videoCircleSource = readFileSync(
  resolve(__dirname, "../VideoCirclePlayer.vue"),
  "utf-8",
);
const linkPreviewSource = readFileSync(
  resolve(__dirname, "../LinkPreviewCard.vue"),
  "utf-8",
);

/** All three webkit/native guards that suppress the WebView long-press drag. */
const expectNativeDragGuard = (tag: string) => {
  expect(tag).toMatch(/draggable="false"/);
  expect(tag).toMatch(/\[-webkit-touch-callout:none\]/);
  expect(tag).toMatch(/\[-webkit-user-drag:none\]/);
  expect(tag).toMatch(/\bselect-none\b/);
};

/**
 * WEE-79 / forta-bugs#948 — Long-press on a received photo froze the whole
 * Android device (hard-reboot only). Root cause: Android WebView's *native*
 * long-press on an `<img>`/`<video>` spins up a drag-and-drop with a
 * full-resolution bitmap shadow. On a low-RAM device a multi-MB full-size
 * photo (see WEE-71) makes that an instant native OOM that takes down the
 * system UI — not just the app.
 *
 * The app's own long-press (pointer events, 500ms) opens the context menu and
 * is unaffected by these CSS guards — they only suppress the *native* callout
 * / drag bitmap. So the menu still opens; the device no longer freezes.
 *
 * These are source-level regression assertions (matching the established
 * MessageBubble test style) because the guard is purely declarative CSS/markup
 * that happy-dom does not execute as real WebView behaviour.
 */
describe("MessageBubble — native long-press media freeze guard (WEE-79)", () => {
  /** Pull the single `<img>` tag that renders the feed photo (feedImageSrc). */
  const feedImgTag = source.match(/<img v-else-if="feedImageSrc"[\s\S]*?\/>/)?.[0] ?? "";
  /** Pull the inline `<video>` tag — anchored on its stable ref, not an
   *  unrelated handler string, so reordering bindings don't silently drop it. */
  const inlineVideoTag = source.match(/<video\b[\s\S]*?ref="inlineVideoRef"[\s\S]*?\/>/)?.[0] ?? "";

  it("locates the feed image and inline video tags", () => {
    expect(feedImgTag).not.toBe("");
    expect(inlineVideoTag).not.toBe("");
  });

  it("disables native drag/callout on the feed photo", () => {
    expectNativeDragGuard(feedImgTag);
  });

  it("disables native drag/callout on the inline video", () => {
    expectNativeDragGuard(inlineVideoTag);
  });

  it("disables native drag/callout on the video-note (videoCircle) player", () => {
    // Same freeze vector — a received video note is a full-res `<video>` the
    // native long-press would also try to drag (review H1).
    const videoNoteTag = videoCircleSource.match(/<video\b[\s\S]*?ref="videoEl"[\s\S]*?\/>/)?.[0] ?? "";
    expect(videoNoteTag).not.toBe("");
    expectNativeDragGuard(videoNoteTag);
  });

  it("disables native drag/callout on the link-preview image", () => {
    const linkImgTag = linkPreviewSource.match(/<img\b[\s\S]*?@error="imageError = true"\s*\/>/)?.[0] ?? "";
    expect(linkImgTag).not.toBe("");
    expectNativeDragGuard(linkImgTag);
  });

  it("keeps the app long-press handler intact (menu still opens)", () => {
    // The fix must NOT remove our own long-press → context-menu emission;
    // only the native WebView callout is suppressed.
    expect(source).toMatch(/useLongPress\(/);
    expect(source).toMatch(/emit\("contextmenu", \{ message: props\.message/);
  });

  it("does not blanket-disable text selection (copy-fragment still works)", () => {
    // A3 regression: the guard is scoped to media tags via class tokens, not a
    // global `user-select: none` on the bubble — text bubbles must stay
    // selectable for the in-bubble copy-fragment feature (WEE-42).
    expect(source).not.toMatch(/class="[^"]*group relative flex gap-2[^"]*select-none/);
  });
});
