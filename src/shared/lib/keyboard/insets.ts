import {
  computed,
  onScopeDispose,
  readonly,
  ref,
  watch,
  type Ref,
} from "vue";
import { isAndroid, isIOS, isNative } from "@/shared/lib/platform";

/**
 * Soft-keyboard height (CSS px), reactive.
 *
 * Sources:
 * - Native: `@capacitor/keyboard` (`keyboardWillShow` / `keyboardWillHide`)
 * - Web/Electron: `visualViewport.resize` vs `window.innerHeight`
 *
 * Android CSS vars are primarily driven by `MainActivity.injectAllCssVars`;
 * this height feed still works there (plugin events) and powers the iOS
 * CSS-var writer + the Android visualViewport cross-check.
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
 * Reactive boolean — soft keyboard open. Threshold 50dp filters nav-bar noise.
 * Non-native always false.
 */
export function useKeyboardVisible(): Readonly<Ref<boolean>> {
  if (!isNative) return readonly(ref(false));
  const height = useKeyboardHeight();
  return readonly(computed(() => height.value > 50));
}

function applyIosCssVars(heightPx: number): void {
  const root = document.documentElement;
  root.style.setProperty("--keyboardheight", `${heightPx}px`);
  root.style.setProperty("--app-bottom-inset", `${heightPx}px`);
  root.style.setProperty(
    "--safe-area-inset-bottom",
    heightPx > 0 ? "0px" : "env(safe-area-inset-bottom, 0px)",
  );
}

/**
 * Android visualViewport cross-check against MainActivity's --app-bottom-inset.
 * OEM firmware sometimes mis-reports IME insets; correct when delta > 30px.
 */
function installAndroidInsetCrossCheck(): void {
  if (!isNative || !isAndroid) return;

  const vv = window.visualViewport;
  if (!vv) return;

  const onVVResize = () => {
    const screenHeight = window.screen.height;
    const dpr = window.devicePixelRatio || 1;
    const screenCssPx = screenHeight / dpr;
    const kbdFromVV = Math.round(screenCssPx - vv.height - vv.offsetTop);

    if (kbdFromVV <= 0) return;

    const nativeInset = parseInt(
      getComputedStyle(document.documentElement).getPropertyValue(
        "--app-bottom-inset",
      ) || "0",
      10,
    );

    if (Math.abs(nativeInset - kbdFromVV) > 30) {
      document.documentElement.style.setProperty(
        "--app-bottom-inset",
        `${kbdFromVV}px`,
      );
    }
  };

  vv.addEventListener("resize", onVVResize);
  onScopeDispose(() => vv.removeEventListener("resize", onVVResize));
}

/**
 * Boot-time keyboard inset wiring for App.vue:
 * - iOS: drive --keyboardheight / --app-bottom-inset / effective safe-area
 * - Android: visualViewport cross-check only (MainActivity is primary)
 */
export function useKeyboardInsets(): void {
  if (isIOS) {
    const h = useKeyboardHeight();
    watch(
      h,
      (v) => {
        applyIosCssVars(v);
      },
      { immediate: true },
    );
    return;
  }

  installAndroidInsetCrossCheck();
}
