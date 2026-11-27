const FOCUSABLE_SELECTOR =
  "input:not([type='hidden']):not([type='file']), textarea, select, [contenteditable='true']";

/**
 * Returns true when the event target is (or is inside) an element that should
 * keep the soft keyboard open — focused fields, or chrome marked with
 * `data-keyboard-aware` (emoji / send / attach buttons next to the textarea).
 */
export function shouldKeepKeyboardOpen(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest(FOCUSABLE_SELECTOR)) return true;
  if (target.closest("[data-keyboard-aware]")) return true;
  return false;
}

export { FOCUSABLE_SELECTOR };
