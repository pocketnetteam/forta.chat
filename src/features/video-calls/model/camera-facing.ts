/**
 * Camera facing-mode detection (WEE-36 / forta-bugs#749).
 *
 * The local self-view was unconditionally mirrored, which felt fine for the
 * default front camera but looked wrong once the user flipped to the back
 * camera — text and lefts/rights appeared reversed for the local user.
 * This helper inspects the active video track's `facingMode` so the bubble's
 * `mirror` flag is only set when the camera is genuinely user-facing.
 *
 * The mirror class is CSS-only (`scale-x-[-1]` on the local `<video>`),
 * so the outgoing WebRTC track sent to the peer is never affected by it.
 */

/**
 * Returns `true` when the given video track is a user-facing (selfie) camera,
 * i.e. its local preview should be mirrored.
 *
 * Heuristic:
 *   - `facingMode === "user"` (or unset) → front camera → mirror.
 *   - `facingMode === "environment" | "left" | "right"` → not front → no mirror.
 *
 * Default for unknown/desktop sources is `true` because typical laptop webcams
 * are user-facing and users expect a mirrored self-view.
 */
export function isFrontFacingTrack(
  track: MediaStreamTrack | null | undefined,
): boolean {
  if (!track) return true;

  let facing: string | undefined;
  try {
    facing = track.getSettings?.().facingMode;
  } catch {
    facing = undefined;
  }

  if (facing === "environment" || facing === "left" || facing === "right") {
    return false;
  }
  return true;
}

/** Convenience: read the first video track from a MediaStream and inspect it. */
export function isFrontFacingStream(
  stream: MediaStream | null | undefined,
): boolean {
  const track = stream?.getVideoTracks?.()[0] ?? null;
  return isFrontFacingTrack(track);
}
