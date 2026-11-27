/**
 * Autofocus policy for soft-keyboard surfaces (plan 1A).
 *
 * On native Capacitor shells and narrow/mobile viewports, overlay search
 * fields must NOT autofocus — opening the IME covers the list the user
 * needs to tap (ForwardPicker, GifPicker, …). Composer autofocus remains
 * for edit / reply / forward-caption after the target chat is chosen.
 *
 * Desktop / Electron keep the previous "focus the search" convenience.
 */

export type KeyboardSurface =
  | "forward-search"
  | "gif-search"
  | "chat-search"
  | "quick-search"
  | "composer-edit"
  | "composer-reply"
  | "composer-forward-caption"
  | "composer-emoji-restore"
  | "form-field"
  | "modal-first-field";

export interface AutofocusContext {
  surface: KeyboardSurface;
  isNative: boolean;
  isMobile: boolean;
}

const OVERLAY_SEARCH_SURFACES: ReadonlySet<KeyboardSurface> = new Set([
  "forward-search",
  "gif-search",
  "chat-search",
  "quick-search",
]);

const COMPOSER_SURFACES: ReadonlySet<KeyboardSurface> = new Set([
  "composer-edit",
  "composer-reply",
  "composer-forward-caption",
  "composer-emoji-restore",
]);

/** True when the surface may programmatically focus an input (opens IME). */
export function shouldAutofocus(ctx: AutofocusContext): boolean {
  const softKeyboardRisk = ctx.isNative || ctx.isMobile;

  if (OVERLAY_SEARCH_SURFACES.has(ctx.surface)) {
    return !softKeyboardRisk;
  }

  if (COMPOSER_SURFACES.has(ctx.surface)) {
    return true;
  }

  // Forms / modal first-field: allowed everywhere — callers that must not
  // open the IME on mobile pass `initialFocus: 'dialog' | 'none'` instead.
  if (ctx.surface === "form-field" || ctx.surface === "modal-first-field") {
    return true;
  }

  return false;
}
