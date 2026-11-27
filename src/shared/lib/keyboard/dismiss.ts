import { onScopeDispose } from "vue";
import { isIOS } from "@/shared/lib/platform";
import { FOCUSABLE_SELECTOR, shouldKeepKeyboardOpen } from "./keep-open";
import { releaseFocus } from "./focus";

/**
 * iOS-only: dismiss the soft keyboard when the user taps outside a text field.
 *
 * WKWebView with `scrollEnabled: false` + our `overflow-hidden` shell does not
 * blur focused inputs on outside taps, so the keyboard stays up indefinitely.
 * Android is intentionally untouched.
 *
 * Call once from `App.vue` setup (inside a Vue effect scope).
 */
export function installKeyboardDismiss(): void {
  if (!isIOS) return;

  const onPointerDown = (e: Event) => {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement)) return;
    if (!active.matches(FOCUSABLE_SELECTOR)) return;
    if (shouldKeepKeyboardOpen(e.target)) return;
    releaseFocus("dismiss", active);
  };

  document.addEventListener("pointerdown", onPointerDown, true);

  onScopeDispose(() => {
    document.removeEventListener("pointerdown", onPointerDown, true);
  });
}
