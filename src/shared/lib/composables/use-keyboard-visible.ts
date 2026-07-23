import {
  computed,
  onScopeDispose,
  ref,
  readonly,
  type Ref,
} from "vue";
import { isNative } from "@/shared/lib/platform";

/**
 * Soft-keyboard height (in CSS px), reactive.
 *
 * Sources:
 * - Native shells: `@capacitor/keyboard` events (`keyboardWillShow` /
 *   `keyboardWillHide`). On Android, the existing `MainActivity` continues
 *   to drive `--keyboardheight` via WindowInsetsCompat — the plugin still
 *   fires events, so this composable works there too.
 * - Web/Electron: `visualViewport.resize` delta against `window.innerHeight`.
 *
 * Returns 0 outside the keyboard. The ref is read-only by design — callers
 * should not mutate the height. Subscriptions are attached eagerly so the
 * composable can be invoked from either `setup` or `onMounted` of a host
 * component; cleanup runs via `onScopeDispose`.
 */
export function useKeyboardHeight(): Readonly<Ref<number>> {
  const height = ref(0);

  let removeShow: (() => void) | undefined;
  let removeHide: (() => void) | undefined;

  const attachVisualViewportFallback = () => {
    const vv = window.visualViewport;
    if (!vv) return;
    const onResize = () => {
      height.value = Math.max(0, window.innerHeight - vv.height);
    };
    vv.addEventListener("resize", onResize);
    removeShow = () => vv.removeEventListener("resize", onResize);
  };

  if (isNative) {
    // Dynamic import keeps the plugin out of the web bundle.
    import("@capacitor/keyboard")
      .then(async ({ Keyboard }) => {
        const showHandle = await Keyboard.addListener(
          "keyboardWillShow",
          (info: { keyboardHeight: number }) => {
            height.value = info.keyboardHeight;
          },
        );
        const hideHandle = await Keyboard.addListener(
          "keyboardWillHide",
          () => {
            height.value = 0;
          },
        );
        removeShow = () => showHandle.remove();
        removeHide = () => hideHandle.remove();
      })
      .catch((err) => {
        console.warn(
          "[Keyboard] plugin unavailable, falling back to visualViewport:",
          err,
        );
        attachVisualViewportFallback();
      });
  } else {
    attachVisualViewportFallback();
  }

  onScopeDispose(() => {
    removeShow?.();
    removeHide?.();
  });

  return readonly(height);
}

/**
 * Reactive boolean indicating whether the soft keyboard is open.
 *
 * Kept for backwards compatibility with consumers that don't care about the
 * exact height. Threshold of 50dp filters out nav-bar fluctuations on
 * gesture-navigation devices.
 *
 * On non-native platforms always returns `false`.
 */
export function useKeyboardVisible(): Readonly<Ref<boolean>> {
  if (!isNative) return readonly(ref(false));
  const height = useKeyboardHeight();
  return readonly(computed(() => height.value > 50));
}
