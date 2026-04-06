/**
 * Pure logic for computing effective keyboard height.
 * Extracted from App.vue for testability.
 */

export interface KeyboardHeightState {
  baseInnerHeight: number;
}

export interface KeyboardHeightInput {
  isNativeEvent: boolean;
  nativeKbh: number;
  webKbh: number;
  innerHeight: number;
}

export interface KeyboardHeightResult {
  kbh: number;
  baseInnerHeight: number;
}

/**
 * Compute the effective keyboard height, applying anti-double-push logic.
 *
 * - Native events are authoritative — anti-double-push is skipped.
 * - For visualViewport events, if innerHeight shrank significantly,
 *   Android adjustResize is already handling it — we return 0.
 */
export function computeKeyboardHeight(
  state: KeyboardHeightState,
  input: KeyboardHeightInput,
): KeyboardHeightResult {
  const { isNativeEvent, nativeKbh, webKbh, innerHeight } = input;

  let kbh = isNativeEvent ? nativeKbh : Math.max(webKbh, nativeKbh);
  let baseInnerHeight = state.baseInnerHeight;

  if (kbh === 0) {
    baseInnerHeight = innerHeight;
  } else if (!isNativeEvent && innerHeight < baseInnerHeight - 50) {
    kbh = 0;
  }

  return { kbh, baseInnerHeight };
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
