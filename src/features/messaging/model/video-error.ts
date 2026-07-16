/**
 * Typed playback errors for the inline chat video bubble (WEE-21).
 *
 * Split off as a pure module so the MediaError → UX mapping can be
 * unit-tested without mounting the 1k-line MessageBubble.vue and its
 * ~10 store/composable mocks.
 */
export type VideoPlaybackError =
  | "codec-unsupported"
  | "decode"
  | "timeout"
  | "generic";

/**
 * Map an HTMLMediaElement `MediaError.code` to a typed playback error.
 *
 * Codes per the HTML spec
 * (https://html.spec.whatwg.org/multipage/media.html#error-codes):
 *   1 MEDIA_ERR_ABORTED        — fetch aborted by user
 *   2 MEDIA_ERR_NETWORK        — network failure mid-load
 *   3 MEDIA_ERR_DECODE         — corrupt frame / decoder crash
 *   4 MEDIA_ERR_SRC_NOT_SUPPORTED — codec / container not supported
 *                                  (H.265 on older Android WebView, etc.)
 *
 * Only code 4 disables the retry button — re-fetching the same blob with
 * the same codec won't suddenly start playing. Everything else is
 * potentially transient, so the bubble offers a retry.
 */
export function videoPlaybackErrorFromMediaError(
  code: number | undefined,
): VideoPlaybackError {
  if (code === 4) return "codec-unsupported";
  if (code === 3) return "decode";
  return "generic";
}

/**
 * Deadline for the inline `<video>` to fire `loadedmetadata` / `canplay`
 * after the decrypted blob URL becomes available. Silent stalls (no event
 * ever fires on older WebView) used to leave the user with an eternal
 * spinner; the timeout flips the bubble into a typed `timeout` error so
 * the retry / download fallback is reachable.
 *
 * 10s gives a slow LTE connection room to deliver the first frame while
 * still failing loudly on a truly stuck decode.
 */
export const VIDEO_LOAD_TIMEOUT_MS = 10000;
