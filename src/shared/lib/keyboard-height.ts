/**
 * Pure logic for computing effective keyboard height.
 * Extracted from App.vue for testability.
 *
 * With adjustNothing, the OS does NOT resize the WebView when the keyboard
 * opens — our CSS padding-bottom is the sole mechanism that lifts content.
 * This eliminates the "double-push" conflict that existed with adjustResize.
 */

declare global {
  interface Window {
    __FORTA_KB_DEBUG?: boolean;
  }
}

export type KeyboardSource = "native" | "virtualKeyboard" | "visualViewport";

export interface KeyboardHeightInput {
  isNativeEvent: boolean;
  nativeKbh: number;
  webKbh: number;
}

/**
 * Compute the effective keyboard height.
 *
 * - Native events (from WindowInsets via MainActivity.kt) are authoritative.
 * - For visualViewport events (web fallback), take the larger of web/native.
 */
export function computeKeyboardHeight(input: KeyboardHeightInput): number {
  if (input.isNativeEvent) return input.nativeKbh;
  return Math.max(input.webKbh, input.nativeKbh);
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

// ── Native-priority lock & source-priority manager ──

const NATIVE_LOCK_MS = 120;
const OCCLUSION_MARGIN_PX = 10;

/**
 * Manages keyboard height source priority and prevents race conditions
 * between native WindowInsetsCompat events and web-derived updates.
 *
 * After a native event arrives, web-derived updates (visualViewport,
 * VirtualKeyboard API) are ignored for NATIVE_LOCK_MS to eliminate
 * jitter / double-update caused by overlapping event sources.
 */
export class KeyboardHeightManager {
  private _lastNativeTs = 0;
  private _lastSource: KeyboardSource = "native";
  private _currentHeight = 0;

  get lastSource(): KeyboardSource {
    return this._lastSource;
  }

  get currentHeight(): number {
    return this._currentHeight;
  }

  /** True when a native event arrived recently and web updates should be skipped. */
  isNativeLocked(now = Date.now()): boolean {
    return now - this._lastNativeTs < NATIVE_LOCK_MS;
  }

  /**
   * Process a keyboard height update from any source.
   * Returns the new effective height, or `null` if the update was suppressed by the lock.
   */
  update(
    source: KeyboardSource,
    input: KeyboardHeightInput,
    now = Date.now(),
  ): number | null {
    if (source === "native") {
      this._lastNativeTs = now;
    } else if (this.isNativeLocked(now)) {
      kbDebug("update SKIPPED (native lock)", { source, input, lockAge: now - this._lastNativeTs });
      return null;
    }

    const height = computeKeyboardHeight(input);
    this._lastSource = source;
    this._currentHeight = height;

    kbDebug("update APPLIED", {
      source,
      nativeKbh: input.nativeKbh,
      webKbh: input.webKbh,
      final: height,
      lockAge: now - this._lastNativeTs,
    });

    return height;
  }

  /** Reset state (e.g. on unmount). */
  reset(): void {
    this._lastNativeTs = 0;
    this._lastSource = "native";
    this._currentHeight = 0;
  }
}

// ── Occlusion check for conditional scrollIntoView ──

/**
 * Returns true if the element's bottom edge is below the visible area
 * (accounting for keyboard height), meaning the keyboard occludes it.
 * Uses a small margin to avoid false negatives from rounding.
 */
export function isOccludedByKeyboard(
  el: HTMLElement,
  keyboardHeight: number,
): boolean {
  if (keyboardHeight <= 0) return false;
  const rect = el.getBoundingClientRect();
  const visibleBottom = window.innerHeight - keyboardHeight - OCCLUSION_MARGIN_PX;
  return rect.bottom > visibleBottom;
}

// ── Debug telemetry (enabled via window.__FORTA_KB_DEBUG = true) ──

export function kbDebug(label: string, data?: Record<string, unknown>): void {
  if (!window.__FORTA_KB_DEBUG) return;

  const vv = window.visualViewport;
  const payload: Record<string, unknown> = {
    ...data,
    ts: Date.now(),
    vvHeight: vv?.height,
    vvOffsetTop: vv?.offsetTop,
    innerHeight: window.innerHeight,
    cssKbh: getComputedStyle(document.documentElement)
      .getPropertyValue("--keyboardheight")
      .trim(),
  };

  console.debug(`[KB] ${label}`, payload);
}

export function kbDebugScroll(
  el: HTMLElement,
  keyboardHeight: number,
  decision: "scroll" | "skip",
): void {
  if (!window.__FORTA_KB_DEBUG) return;
  const rect = el.getBoundingClientRect();
  console.debug(`[KB] scrollIntoView ${decision}`, {
    tag: el.tagName,
    rectBottom: rect.bottom,
    threshold: window.innerHeight - keyboardHeight - OCCLUSION_MARGIN_PX,
    keyboardHeight,
  });
}
