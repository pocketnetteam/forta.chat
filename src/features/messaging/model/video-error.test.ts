import { describe, it, expect } from "vitest";
import {
  videoPlaybackErrorFromMediaError,
  VIDEO_LOAD_TIMEOUT_MS,
  type VideoPlaybackError,
} from "./video-error";

/**
 * Regression for WEE-21 (forta-bugs#761, #748, #679, #652, #532).
 *
 * Video bubbles in chat used to spin forever when decoding failed:
 * H.265-encoded files on older Android WebView surface as a "green Android"
 * placeholder, decode errors looked identical to "still buffering", and a
 * silent stall (no progress event fires) left the user with no recourse.
 *
 * The mapping below is the contract between the raw HTML5 MediaError code
 * and the typed UX shown in the bubble — codec-unsupported gets only a
 * Download fallback (retry won't help), decode/generic gets a retry button.
 */
describe("videoPlaybackErrorFromMediaError", () => {
  it("maps MEDIA_ERR_SRC_NOT_SUPPORTED (4) → codec-unsupported", () => {
    // H.265 (HEVC) on a WebView without the codec is the dominant cause of
    // the green-placeholder bug on Huawei/older Xiaomi devices.
    expect(videoPlaybackErrorFromMediaError(4)).toBe<VideoPlaybackError>("codec-unsupported");
  });

  it("maps MEDIA_ERR_DECODE (3) → decode", () => {
    expect(videoPlaybackErrorFromMediaError(3)).toBe<VideoPlaybackError>("decode");
  });

  it("maps MEDIA_ERR_NETWORK (2) → generic so the bubble offers retry", () => {
    expect(videoPlaybackErrorFromMediaError(2)).toBe<VideoPlaybackError>("generic");
  });

  it("maps MEDIA_ERR_ABORTED (1) → generic", () => {
    expect(videoPlaybackErrorFromMediaError(1)).toBe<VideoPlaybackError>("generic");
  });

  it("falls back to generic when the code is undefined", () => {
    // Some WebViews emit the `error` event without populating `MediaError`.
    // The UX must still degrade gracefully instead of crashing the handler.
    expect(videoPlaybackErrorFromMediaError(undefined)).toBe<VideoPlaybackError>("generic");
  });

  it("falls back to generic for unknown numeric codes", () => {
    expect(videoPlaybackErrorFromMediaError(0)).toBe<VideoPlaybackError>("generic");
    expect(videoPlaybackErrorFromMediaError(99)).toBe<VideoPlaybackError>("generic");
  });
});

describe("VIDEO_LOAD_TIMEOUT_MS", () => {
  it("exposes a 10-second load timeout (matches WEE-21 acceptance criteria)", () => {
    // 10s gives a slow LTE connection room to deliver the first frame while
    // still failing loudly on a truly stalled decode. Acceptance criteria A1
    // talks about "playback within 5s on WiFi" — 10s is the upper bound for
    // a still-recoverable load.
    expect(VIDEO_LOAD_TIMEOUT_MS).toBe(10000);
  });
});
