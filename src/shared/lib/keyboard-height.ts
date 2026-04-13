/**
 * Pure logic for computing effective keyboard height.
 * Extracted from App.vue for testability.
 *
 * With adjustNothing, the OS does NOT resize the WebView when the keyboard
 * opens — our CSS padding-bottom is the sole mechanism that lifts content.
 * This eliminates the "double-push" conflict that existed with adjustResize.
 */

export interface KeyboardHeightInput {
  isNativeEvent: boolean;
  nativeKbh: number;
  webKbh: number;
}

// Tracks the last keyboard height reported by a native event.
// Used for Samsung hysteresis: when visualViewport fires a stale near-zero
// scroll event before the native-keyboard-change height=0 arrives, we hold
// the prior native value to prevent a visible blank-space flash.
let lastNativeKbh = 0;

/**
 * Compute the effective keyboard height.
 *
 * - Native events (from WindowInsets via MainActivity.kt) are authoritative.
 * - For visualViewport events (web fallback), take the larger of web/native,
 *   but guard against Samsung's scroll-vs-resize race: if the last native
 *   event reported a large keyboard height (>50px) and the current candidate
 *   is near-zero (<50px), hold the prior native value until the native event
 *   explicitly zeroes it.
 */
export function computeKeyboardHeight(input: KeyboardHeightInput): number {
  if (input.isNativeEvent) {
    lastNativeKbh = input.nativeKbh;
    return input.nativeKbh;
  }

  const candidate = Math.max(input.webKbh, input.nativeKbh);

  // Hysteresis guard: prevent false-zero from Samsung stale visualViewport scroll.
  // Only holds when native already confirmed a large keyboard AND candidate drops
  // near-zero. Once the native event fires with 0, lastNativeKbh is reset and
  // this guard no longer applies.
  if (lastNativeKbh > 50 && candidate < 50) {
    return lastNativeKbh;
  }

  return candidate;
}

/**
 * Check whether a focused element should be excluded from the global
 * scrollIntoView handler. Elements with `data-keyboard-aware` manage
 * their own keyboard-related scrolling (e.g. chat message input).
 */
export function shouldScrollIntoView(target: HTMLElement): boolean {
  if (target.dataset?.keyboardAware !== undefined) return false;
  return (
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.isContentEditable
  );
}
