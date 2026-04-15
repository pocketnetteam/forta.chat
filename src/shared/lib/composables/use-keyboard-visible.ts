import { ref, readonly, onScopeDispose, type Ref } from "vue";
import { isNative } from "@/shared/lib/platform";

/**
 * Reactive boolean indicating whether the soft keyboard is open.
 *
 * Reads `--keyboardheight` CSS variable set by native code (MainActivity.kt)
 * and re-checks on `visualViewport.resize` events. Threshold of 50dp filters
 * out nav-bar fluctuations on gesture-navigation devices.
 *
 * On non-native platforms always returns `false`.
 */
export function useKeyboardVisible(): Readonly<Ref<boolean>> {
  const isOpen = ref(false);

  if (!isNative) return readonly(isOpen);

  const check = () => {
    const raw = getComputedStyle(document.documentElement).getPropertyValue(
      "--keyboardheight",
    );
    isOpen.value = parseInt(raw || "0", 10) > 50;
  };

  const vv = window.visualViewport;
  if (vv) {
    vv.addEventListener("resize", check);
    onScopeDispose(() => vv.removeEventListener("resize", check));
  } else {
    window.addEventListener("resize", check);
    onScopeDispose(() => window.removeEventListener("resize", check));
  }

  check();
  return readonly(isOpen);
}
