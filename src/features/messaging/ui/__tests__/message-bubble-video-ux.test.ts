import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

/**
 * UX regression for WEE-32 (forta-bugs#788, #789).
 *
 * Video bubbles in chat must look like Telegram/WhatsApp, not a bare HTML5
 * `<video controls>`. The bubble has to render:
 *   1. A generated first-frame poster (or `<video poster>`), not a generic grey
 *      placeholder.
 *   2. A Telegram-style duration badge in the bottom-right corner.
 *   3. A circular play-button overlay centered on the frame when not playing.
 *   4. Rounded corners + an aspect-aware frame that doesn't collapse to 64x192.
 *
 * Mounting the 946-line MessageBubble.vue requires ~10 store/composable mocks,
 * which is out of proportion with the wiring we want to verify. A source-level
 * assertion matches the existing decrypt-error-UX regression test and keeps the
 * verification surface focused on the changes.
 */
const getSource = (): string =>
  readFileSync(resolve(__dirname, "../MessageBubble.vue"), "utf-8");

const getVideoBlock = (): string => {
  const source = getSource();
  const start = source.indexOf("<!-- Video message -->");
  expect(start, "Video message block should exist in MessageBubble.vue").toBeGreaterThan(-1);
  // The next sibling block is the audio/voice message — slice up to it so
  // assertions only fire against the inline video bubble.
  const nextBlock = source.indexOf("<!-- Audio", start);
  const end = nextBlock > -1 ? nextBlock : source.indexOf("<!-- File", start);
  expect(end, "Should find a sibling block after the video bubble").toBeGreaterThan(start);
  return source.slice(start, end);
};

describe("MessageBubble — modern video bubble UX (WEE-32)", () => {
  it("imports the shared video-thumbnail helpers", () => {
    const source = getSource();
    expect(source).toMatch(/from\s+["']\.\.\/model\/video-thumbnail["']/);
    expect(source).toContain("formatVideoDuration");
    expect(source).toContain("extractVideoFrameThumbnail");
  });

  it("renders a duration badge bottom-right when the duration is known", () => {
    const source = getSource();
    const block = getVideoBlock();
    // The badge must be positioned bottom-right with a translucent dark
    // background — that's the Telegram/WhatsApp convention.
    expect(source).toMatch(/formatVideoDuration\(/);
    expect(block).toContain("videoDurationText");
    expect(block).toMatch(/absolute[^"]*bottom-[12]/);
    expect(block).toMatch(/right-[12]/);
  });

  it("renders a centered circular play-button overlay when the video is paused", () => {
    const block = getVideoBlock();
    // The overlay must hide once playback starts so the native controls take
    // over. Look for the play-icon polygon and a guard on `isVideoPlaying`.
    expect(block).toContain("isVideoPlaying");
    expect(block).toMatch(/rounded-full/);
    expect(block).toMatch(/polygon\s+points="6\s+4\s+20\s+12\s+6\s+20\s+6\s+4"|polygon\s+points="5\s+3\s+19\s+12\s+5\s+21\s+5\s+3"/);
  });

  it("does not show native <video controls> while the play-button overlay is visible", () => {
    const block = getVideoBlock();
    // Native controls must be reactive to playback state — a hard-coded
    // `controls` attribute would clash with our custom overlay.
    expect(block).not.toMatch(/<video[^>]*\scontrols(?!\s*=|\s*:)/);
    expect(block).toMatch(/:controls=/);
  });

  it("wires the play-button overlay to play() the inline <video> element", () => {
    const source = getSource();
    // The button click must imperatively start playback through the existing
    // inlineVideoRef so the same element is reused (preserves position state).
    expect(source).toContain("playInlineVideo");
    const fnStart = source.indexOf("const playInlineVideo");
    expect(fnStart).toBeGreaterThan(-1);
    const fn = source.slice(fnStart, source.indexOf("};", fnStart));
    expect(fn).toMatch(/inlineVideoRef\.value/);
    expect(fn).toMatch(/\.play\(\)/);
  });

  it("uses a generated poster URL on the inline <video> tag", () => {
    const block = getVideoBlock();
    // The poster must reflect the lazily-extracted first frame; a missing
    // poster binding regresses to the generic grey HTML5 placeholder.
    expect(block).toMatch(/:poster=/);
  });

  it("revokes the generated poster blob URL on unmount to avoid leaks", () => {
    const source = getSource();
    // The poster is held as a blob URL — without an explicit revoke the URL
    // outlives the component scope and leaks until the page reloads.
    expect(source).toMatch(/revokeObjectURL/);
  });
});
