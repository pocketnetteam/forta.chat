import { onScopeDispose } from "vue";
import { isIOS } from "@/shared/lib/platform";

const FOCUSABLE_SELECTOR =
  "input:not([type='hidden']):not([type='file']), textarea, select, [contenteditable='true']";

/**
 * Returns true when the event target is (or is inside) an element that should
 * keep the soft keyboard open — focused fields, or the composer chrome marked
 * with `data-keyboard-aware` (emoji / send / attach buttons next to the
 * textarea).
 */
export function shouldKeepKeyboardOpen(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest(FOCUSABLE_SELECTOR)) return true;
  if (target.closest("[data-keyboard-aware]")) return true;
  return false;
}

/**
 * iOS-only: dismiss the soft keyboard when the user taps outside a text field.
 *
 * WKWebView with `scrollEnabled: false` + our `overflow-hidden` shell does not
 * blur focused inputs on outside taps, so the keyboard stays up indefinitely.
 * Android is intentionally untouched (parallel keyboard workstream).
 *
 * Call once from `App.vue` setup / onMounted (inside a Vue effect scope).
 */
export function useIOSKeyboardDismiss(): void {
  if (!isIOS) return;

  const onPointerDown = (e: Event) => {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement)) return;
    if (!active.matches(FOCUSABLE_SELECTOR)) return;
    if (shouldKeepKeyboardOpen(e.target)) return;
    active.blur();
  };

  // Capture phase so we run before scrollers / buttons that stopPropagation.
  document.addEventListener("pointerdown", onPointerDown, true);

  onScopeDispose(() => {
    document.removeEventListener("pointerdown", onPointerDown, true);
  });
}
