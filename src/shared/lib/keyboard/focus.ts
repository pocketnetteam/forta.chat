import { nextTick } from "vue";
import { isNative } from "@/shared/lib/platform";
import { shouldAutofocus, type KeyboardSurface } from "./policy";

export type FocusReleaseReason =
  | "dismiss"
  | "overlay"
  | "navigate"
  | "picker"
  | "manual";

export interface RequestFocusOptions {
  /** Skip preventScroll (default true — avoids WebView header push). */
  preventScroll?: boolean;
  /** Override the soft-keyboard risk flags (tests / forced desktop). */
  isMobile?: boolean;
}

/**
 * Single entry for programmatic IME open. Honours {@link shouldAutofocus};
 * no-ops when the surface is blocked on native/mobile.
 */
export function requestFocus(
  el: HTMLElement | null | undefined,
  surface: KeyboardSurface,
  opts: RequestFocusOptions = {},
): boolean {
  if (!el) return false;
  const isMobile = opts.isMobile ?? false;
  if (!shouldAutofocus({ surface, isNative, isMobile })) return false;

  const preventScroll = opts.preventScroll !== false;
  try {
    el.focus({ preventScroll });
  } catch {
    el.focus();
  }
  return document.activeElement === el;
}

type FocusTarget =
  | HTMLElement
  | null
  | undefined
  | (() => HTMLElement | null | undefined);

/** Focus after the next DOM paint (Vue watchers / remounts). */
export async function requestFocusNextTick(
  el: FocusTarget,
  surface: KeyboardSurface,
  opts: RequestFocusOptions = {},
): Promise<boolean> {
  await nextTick();
  const target = typeof el === "function" ? el() : el;
  return requestFocus(target, surface, opts);
}

/**
 * Single entry for programmatic IME close. Blurs the active focusable, or
 * the provided element when it still holds focus.
 */
export function releaseFocus(
  reason: FocusReleaseReason,
  el?: HTMLElement | null,
): void {
  void reason;
  const active = document.activeElement;
  if (el && active === el) {
    el.blur();
    return;
  }
  if (active instanceof HTMLElement) {
    active.blur();
  }
}
