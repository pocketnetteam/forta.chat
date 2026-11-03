import { ref } from "vue";

export interface UseLongPressOptions {
  delay?: number;
  moveThreshold?: number;
  onTrigger: (e: PointerEvent) => void;
}

/**
 * Whether text inside `el` is selected. On Android the same long press that
 * arms the message menu also starts a native text selection, and the menu
 * opened over the selection handles (audit W2C-01).
 */
export function hasTextSelectionIn(el: Element | null): boolean {
  if (!el || typeof window === "undefined") return false;
  try {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.toString().trim()) return false;
    return (!!sel.anchorNode && el.contains(sel.anchorNode)) || (!!sel.focusNode && el.contains(sel.focusNode));
  } catch {
    return false;
  }
}

export function useLongPress(options: UseLongPressOptions) {
  const { delay = 500, moveThreshold = 10, onTrigger } = options;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let startX = 0;
  let startY = 0;
  const pressed = ref(false);

  const clear = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    pressed.value = false;
  };

  const onPointerdown = (e: PointerEvent) => {
    startX = e.clientX;
    startY = e.clientY;
    pressed.value = true;
    timer = setTimeout(() => {
      onTrigger(e);
      pressed.value = false;
    }, delay);
  };

  const onPointermove = (e: PointerEvent) => {
    if (!timer) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (Math.sqrt(dx * dx + dy * dy) > moveThreshold) {
      clear();
    }
  };

  const onPointerup = () => clear();
  const onPointerleave = () => clear();
  // The browser cancels the pointer when it takes the gesture over, e.g. for
  // a native text selection or a scroll.
  const onPointercancel = () => clear();
  const onContextmenu = (e: Event) => e.preventDefault();

  return { pressed, onPointerdown, onPointermove, onPointerup, onPointerleave, onPointercancel, onContextmenu };
}
