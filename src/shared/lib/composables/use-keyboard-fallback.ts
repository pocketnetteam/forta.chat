import { onScopeDispose } from "vue";
import { isNative } from "@/shared/lib/platform";

/**
 * Android keyboard handling for Capacitor WebView.
 *
 * Root app-shell uses `position: fixed; inset: 0` — document scroll
 * does NOT move it, so no scroll prevention is needed. The OS handles
 * viewport resize via `adjustResize`, and the browser natively scrolls
 * focused inputs into view.
 *
 * This composable provides an inset cross-check via `visualViewport` API
 * (Chrome 61+, covers WebView 114+) to catch OEM firmware anomalies
 * where `WindowInsetsCompat` reports incorrect IME heights.
 *
 * Call once in the root component (App.vue) `onMounted`.
 */
export function useKeyboardFallback(): void {
  if (!isNative) return;

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
