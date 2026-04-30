/**
 * Pure decision functions for the scroll-to-bottom FAB and banner auto-dismiss.
 *
 * Coordinate model — column-reverse virtual list (`reversedItems`):
 *   idx 0   = newest message  = visual BOTTOM of screen
 *   idx N-1 = oldest message  = visual TOP of screen
 *
 * `VisibleRange` describes which item indices are currently rendered in the
 * viewport. In column-reverse layout:
 *   - `start` = TOP of viewport  → larger index (older)
 *   - `end`   = BOTTOM of viewport → smaller index (newer)
 *   - invariant: start ≥ end (when range is non-empty)
 *
 * Banner position relative to viewport (canonical wording — keep in sync with tests):
 *   - banner above viewport (user below banner)   ⇔  range.start < bannerIdx
 *   - banner inside viewport                       ⇔  range.start ≥ bannerIdx ≥ range.end
 *   - banner below viewport (user above banner)   ⇔  range.end   > bannerIdx
 */

export interface VisibleRange {
  /** Top of viewport — larger idx in column-reverse. */
  start: number;
  /** Bottom of viewport — smaller idx in column-reverse. */
  end: number;
}

export type FabAction =
  | { kind: "scroll-to-banner"; bannerIdx: number }
  | { kind: "scroll-to-bottom-and-dismiss" }
  | { kind: "return-to-latest" }
  | { kind: "scroll-to-bottom" };

export interface FabDecisionInput {
  hasBanner: boolean;
  /** Index of the unread banner in the reversed virtual list, or -1 if not present. */
  bannerIdx: number;
  /** Currently visible idx range, or null if scroller hasn't measured yet. */
  visibleRange: VisibleRange | null;
  isDetachedFromLatest: boolean;
}

/**
 * Telegram-like FAB click decision.
 *
 * - Above or at banner → scroll to banner.
 * - Below banner (already passed it) → scroll to bottom and dismiss banner.
 * - No banner: detached → return-to-latest, otherwise → scroll to bottom.
 *
 * If we cannot determine position (visibleRange is null), we default to
 * scroll-to-banner — the conservative choice that preserves prior behavior.
 */
export function decideFabAction(input: FabDecisionInput): FabAction {
  const { hasBanner, bannerIdx, visibleRange, isDetachedFromLatest } = input;

  if (hasBanner && bannerIdx >= 0) {
    if (visibleRange && visibleRange.start < bannerIdx) {
      return { kind: "scroll-to-bottom-and-dismiss" };
    }
    return { kind: "scroll-to-banner", bannerIdx };
  }

  if (isDetachedFromLatest) {
    return { kind: "return-to-latest" };
  }
  return { kind: "scroll-to-bottom" };
}

export interface AutoDismissInput {
  hasBanner: boolean;
  bannerIdx: number;
  visibleRange: VisibleRange | null;
  /** Time elapsed since the room was opened / banner was frozen (ms). */
  msSinceRoomOpen: number;
}

/** Sanity guard against firing forceDismiss during the room-switch race. */
const AUTO_DISMISS_GRACE_MS = 200;

/**
 * Returns `true` when the user has explicitly scrolled past the banner downward
 * and enough time has elapsed since room open to be sure this isn't a race
 * during initial layout.
 *
 * The caller should invoke this on each scroll tick and call `forceDismiss()`
 * on the unread banner composable when this returns true.
 */
export function shouldAutoDismissBanner(input: AutoDismissInput): boolean {
  const { hasBanner, bannerIdx, visibleRange, msSinceRoomOpen } = input;

  if (!hasBanner) return false;
  if (bannerIdx < 0) return false;
  if (!visibleRange) return false;
  if (msSinceRoomOpen < AUTO_DISMISS_GRACE_MS) return false;

  // Banner sits above the visible area → user has already scrolled past it.
  return visibleRange.start < bannerIdx;
}
