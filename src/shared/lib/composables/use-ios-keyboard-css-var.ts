import { watch } from "vue";
import { useKeyboardHeight } from "./use-keyboard-visible";
import { isIOS } from "@/shared/lib/platform";

/**
 * Drive `--keyboardheight`, `--app-bottom-inset` and an effective
 * `--safe-area-inset-bottom` from `@capacitor/keyboard` events on iOS.
 *
 * Android already drives these from `MainActivity.injectAllCssVars`, so
 * this composable short-circuits when not on iOS. The CSS shell reads
 * the same variables on both platforms — keeping the surface uniform
 * means we don't need a separate iOS layout pass.
 *
 * Must be called from a component's `setup` (inside a Vue effect scope)
 * so the `onMounted`/`onScopeDispose` lifecycle of `useKeyboardHeight()`
 * is wired correctly. Call site: `App.vue`.
 */
export function useIOSKeyboardCssVar(): void {
  if (!isIOS) return;
  const h = useKeyboardHeight();
  watch(
    h,
    (v) => {
      const root = document.documentElement;
      root.style.setProperty("--keyboardheight", `${v}px`);
      root.style.setProperty("--app-bottom-inset", `${v}px`);
      // Match Android semantics: when the keyboard is up, the home-indicator
      // safe-area is occluded by the keyboard, so the effective inset is 0.
      // Otherwise fall back to the CSS env() value resolved by WKWebView.
      root.style.setProperty(
        "--safe-area-inset-bottom",
        v > 0 ? "0px" : "env(safe-area-inset-bottom, 0px)",
      );
    },
    { immediate: true },
  );
}
