/** Pure pinch-zoom math — no DOM, no Vue. Lets us unit-test the gesture
 *  without spinning up a touch-capable browser.
 *
 *  Production callers feed in TouchList-derived [x, y] pairs and the prior
 *  scale; the helper returns the next scale clamped to MIN/MAX_SCALE so a
 *  too-fast pinch can't escape the bounds and lock the image off-screen. */

export const MIN_SCALE = 1;
export const MAX_SCALE = 4;

export function touchDistance(a: [number, number], b: [number, number]): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  return Math.hypot(dx, dy);
}

/** Compute the scale after a single pinch step.
 *  - `lastDistance <= 0` means we're starting a new pinch — return the
 *    current scale unchanged so the first move doesn't snap.
 *  - Otherwise scale ∝ currentDistance / lastDistance, clamped to bounds. */
export function nextScale(
  currentScale: number,
  lastDistance: number,
  currentDistance: number,
): number {
  if (lastDistance <= 0 || currentDistance <= 0) return currentScale;
  const factor = currentDistance / lastDistance;
  const next = currentScale * factor;
  return Math.max(MIN_SCALE, Math.min(MAX_SCALE, next));
}
