import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

/**
 * Regression for WEE-21 (forta-bugs#761, #748, #679, #652, #532).
 *
 * Before the fix, the inline video bubble had no `@error` handler and no
 * load timeout — a failed decrypt/decode/codec-mismatch would either spin
 * forever or surface the bare Android WebView placeholder (the infamous
 * "green icon"). The state machine here guarantees:
 *
 *   1. `@error` is bound and routes MediaError codes into typed states.
 *   2. A 10s deadline arms when the blob URL arrives and disarms on
 *      `loadedmetadata` / `canplay` — so a silent stall surfaces as a
 *      typed timeout instead of an eternal spinner.
 *   3. The bubble renders an error overlay with localized copy + a
 *      Download fallback. Retry is only offered for transient errors;
 *      codec-unsupported needs a download, not a re-try.
 *   4. Recycling the bubble (virtual scroller swaps `message.id`) clears
 *      the error so a stale failure does not bleed into the next video.
 *
 * Source-level assertions keep the verification surface focused without
 * mounting the 1k-line MessageBubble.vue + 10 store mocks. The same pattern
 * already in `message-bubble-video-ux.test.ts` / decrypt-error-ux test.
 */
const getSource = (): string =>
  readFileSync(resolve(__dirname, "../MessageBubble.vue"), "utf-8");

const getVideoBlock = (): string => {
  const source = getSource();
  const start = source.indexOf("<!-- Video message -->");
  expect(start, "Video message block should exist in MessageBubble.vue").toBeGreaterThan(-1);
  const end = source.indexOf("<!-- Audio", start);
  expect(end, "Should find the audio block after the video bubble").toBeGreaterThan(start);
  return source.slice(start, end);
};

describe("MessageBubble — video playback state machine (WEE-21)", () => {
  it("binds @error on the inline <video> to a typed handler", () => {
    const block = getVideoBlock();
    expect(block).toMatch(/@error=/);
    // The handler name itself is asserted so wiring stays explicit.
    expect(block).toContain("onInlineVideoError");
  });

  it("tracks the typed error in a reactive `videoPlaybackError` ref", () => {
    const source = getSource();
    expect(source).toContain("videoPlaybackError");
    // The ref must be typed nullable so the absence of error is the
    // initial / cleared state.
    expect(source).toMatch(/videoPlaybackError\s*=\s*ref<\s*VideoPlaybackError\s*\|\s*null\s*>/);
  });

  it("delegates MediaError → typed error to the pure helper module", () => {
    const source = getSource();
    // The script imports the pure mapper so the logic is unit-testable
    // without mounting Vue.
    expect(source).toMatch(/from\s+["']\.\.\/model\/video-error["']/);
    expect(source).toContain("videoPlaybackErrorFromMediaError");
  });

  it("arms a load timeout when the decrypted blob URL becomes available", () => {
    const source = getSource();
    // The timer module constant must be imported, not redefined inline.
    expect(source).toContain("VIDEO_LOAD_TIMEOUT_MS");
    // The constant must end up as the delay argument of a setTimeout call
    // — `[\s\S]*?` keeps the regex tolerant of the arrow-fn body in between.
    expect(source).toMatch(/setTimeout\([\s\S]*?VIDEO_LOAD_TIMEOUT_MS\s*\)/);
    // The "timeout" state must be reachable.
    expect(source).toMatch(/videoPlaybackError\.value\s*=\s*["']timeout["']/);
  });

  it("guards the timeout write so it cannot clobber a more specific error", () => {
    const source = getSource();
    // After @error sets "decode"/"codec-unsupported", the still-pending
    // timer must NOT replace it with "timeout" 10s later. The guard checks
    // `videoPlaybackError === null` before assigning "timeout".
    const armStart = source.indexOf("const armVideoLoadTimer");
    expect(armStart, "armVideoLoadTimer must exist").toBeGreaterThan(-1);
    const armEnd = source.indexOf("};", armStart);
    const block = source.slice(armStart, armEnd);
    expect(block).toMatch(/videoPlaybackError\.value\s*===\s*null/);
  });

  it("clears the timeout on @loadedmetadata and @canplay so it cannot fire late", () => {
    const block = getVideoBlock();
    expect(block).toMatch(/@loadedmetadata=/);
    expect(block).toMatch(/@canplay=/);
    const source = getSource();
    expect(source).toContain("clearVideoLoadTimer");
  });

  it("renders an error overlay with the localized message and a download button", () => {
    const block = getVideoBlock();
    expect(block).toContain("videoPlaybackError");
    expect(block).toContain("videoErrorMessage");
    // The download fallback reuses the existing save-to-gallery handler so
    // a codec-unsupported video still ends up on the user's device.
    expect(block).toContain("handleFileDownload");
  });

  it("references the new localization keys for the error overlay", () => {
    const source = getSource();
    expect(source).toContain("message.videoUnsupportedFormat");
    expect(source).toContain("message.videoLoadFailed");
    expect(source).toContain("message.videoDownload");
  });

  it("offers retry for transient errors but not for codec-unsupported", () => {
    const source = getSource();
    expect(source).toContain("retryVideoPlayback");
    // `videoCanRetry` must explicitly exclude codec-unsupported — a re-try
    // on a missing codec can't succeed and would just bait the user.
    expect(source).toContain("videoCanRetry");
    const fnStart = source.indexOf("const videoCanRetry");
    expect(fnStart).toBeGreaterThan(-1);
    const fn = source.slice(fnStart, source.indexOf(";", fnStart) + 1);
    expect(fn).toContain("codec-unsupported");
  });

  it("resets playback error when the bubble is recycled to a new message", () => {
    const source = getSource();
    // The existing watch on props.message.id (added for WEE-32) must also
    // clear the playback error — otherwise a recycled bubble inherits the
    // previous video's failure overlay. Walk to the closing `},\n);` of
    // the watch call so inner `revokePoster();` does not truncate the block.
    const watchStart = source.indexOf("watch(\n  () => props.message.id,");
    expect(watchStart, "watch on message.id must exist").toBeGreaterThan(-1);
    const closing = source.indexOf("\n);", watchStart);
    expect(closing, "watch call must close with \\n);").toBeGreaterThan(watchStart);
    const block = source.slice(watchStart, closing + 3);
    expect(block).toMatch(/videoPlaybackError\.value\s*=\s*null/);
  });

  it("clears the load timer on unmount to avoid late writes to a dead ref", () => {
    const source = getSource();
    const lifecycleStart = source.indexOf("onBeforeUnmount(() => {");
    expect(lifecycleStart).toBeGreaterThan(-1);
    const block = source.slice(lifecycleStart, source.indexOf("});", lifecycleStart) + 3);
    expect(block).toContain("clearVideoLoadTimer");
  });
});

describe("MessageBubble — localization keys for video error UX (WEE-21)", () => {
  const loadLocale = (filename: string): string =>
    readFileSync(
      resolve(__dirname, "../../../../shared/lib/i18n/locales", filename),
      "utf-8",
    );

  it("defines Russian copy for the three new error keys", () => {
    const ru = loadLocale("ru.ts");
    expect(ru).toContain("message.videoUnsupportedFormat");
    expect(ru).toContain("message.videoLoadFailed");
    expect(ru).toContain("message.videoDownload");
  });

  it("defines English copy for the three new error keys", () => {
    const en = loadLocale("en.ts");
    expect(en).toContain("message.videoUnsupportedFormat");
    expect(en).toContain("message.videoLoadFailed");
    expect(en).toContain("message.videoDownload");
  });
});
