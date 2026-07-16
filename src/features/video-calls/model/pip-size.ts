/**
 * Self-view PiP geometry for the in-call window (forta-bugs#433 / WEE-53).
 *
 * The local self-preview used to render inside a fixed ~4:3 landscape box and
 * fill it with `object-fit: cover`. On a phone held vertically the front
 * camera produces a portrait stream (≈9:16), so `cover` cropped away the left
 * and right of the frame — users saw only a square slice of themselves and
 * could not tell what the peer actually received.
 *
 * Instead of hard-coding one aspect, the PiP now follows the *source* aspect
 * ratio: we keep the long edge fixed and derive the short edge from the
 * stream's natural ratio. The container then matches the video exactly, so
 * `cover` no longer crops — the user sees the full frame, same as the peer.
 *
 * Pure module (no Vue / DOM) so the geometry is unit-testable in isolation.
 */

/** Long edge (px) of the PiP thumbnail on mobile (<640px) layouts. */
export const PIP_LONG_EDGE_MOBILE = 120;
/** Long edge (px) of the PiP thumbnail on desktop layouts. */
export const PIP_LONG_EDGE_DESKTOP = 160;

/**
 * Fallback aspect (width / height) used until the real stream metadata
 * arrives. 4:3 matches the previous fixed PiP dimensions so there is no
 * visible size jump on the first frame before `loadedmetadata` fires.
 */
export const PIP_DEFAULT_ASPECT = 4 / 3;

/**
 * Clamp the source aspect into a sane thumbnail range. Without this an
 * ultrawide screen-share (e.g. 21:9) would render the PiP as a thin sliver,
 * and a pathological tall source as an unusable column. The bounds comfortably
 * cover phone portrait (9:16 ≈ 0.5625) and landscape (16:9 ≈ 1.78).
 */
export const PIP_MIN_ASPECT = 0.4;
export const PIP_MAX_ASPECT = 2.4;

export interface PipSize {
  w: number;
  h: number;
}

/**
 * Compute PiP width/height (px) for a given source aspect ratio.
 *
 * @param aspect width/height of the local stream, or `null` before metadata
 *   is known (falls back to {@link PIP_DEFAULT_ASPECT}).
 * @param isMobile whether the call window is in its mobile layout.
 */
export function computePipSize(aspect: number | null, isMobile: boolean): PipSize {
  const longEdge = isMobile ? PIP_LONG_EDGE_MOBILE : PIP_LONG_EDGE_DESKTOP;

  const safeAspect =
    aspect !== null && Number.isFinite(aspect) && aspect > 0
      ? Math.min(PIP_MAX_ASPECT, Math.max(PIP_MIN_ASPECT, aspect))
      : PIP_DEFAULT_ASPECT;

  if (safeAspect >= 1) {
    // Landscape (or square): width is the long edge, height derived.
    return { w: longEdge, h: Math.round(longEdge / safeAspect) };
  }
  // Portrait: height is the long edge, width derived.
  return { w: Math.round(longEdge * safeAspect), h: longEdge };
}
