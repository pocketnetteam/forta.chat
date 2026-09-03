import { Capacitor } from "@capacitor/core";
import type { ElectronAPI } from "@/shared/types/electron";

export { resolveAppUpdaterEnabled } from "./resolve-app-updater-enabled";

/**
 * Live Capacitor native check — re-reads `window.androidBridge` /
 * iOS bridge on every call. Prefer this for UI gates (AI tab, Settings →
 * Local AI): a one-shot snapshot at module import can stick to `false` if
 * the bridge is not visible yet when the chunk first evaluates.
 */
export function isNativePlatform(): boolean {
  return Capacitor.isNativePlatform();
}

/** Live platform id (`android` / `ios` / `web`). */
export function getCapacitorPlatform(): string {
  return Capacitor.getPlatform();
}

/**
 * Snapshot at module load. Kept for the many existing call sites; for new
 * native-only UI prefer {@link isNativePlatform} so a late bridge still
 * unlocks the feature within the same session.
 */
export const isNative = Capacitor.isNativePlatform();

/** True on Android specifically (module-load snapshot). */
export const isAndroid = Capacitor.getPlatform() === "android";

/** True on iOS specifically (module-load snapshot). */
export const isIOS = Capacitor.getPlatform() === "ios";

/** One-line diagnostic for logcat / chrome://inspect — snapshot vs live. */
export function logPlatformGate(tag = "[Platform]"): void {
  const live = isNativePlatform();
  const platform = getCapacitorPlatform();
  const bridge =
    typeof window !== "undefined" &&
    !!(window as Window & { androidBridge?: unknown }).androidBridge;
  if (live !== isNative) {
    console.warn(`${tag} isNative snapshot mismatch`, {
      snapshot: isNative,
      live,
      platform,
      androidBridge: bridge,
    });
  } else {
    console.info(`${tag}`, { isNative, live, platform, androidBridge: bridge });
  }
}

/** Safe accessor for the Electron preload API (undefined outside Electron). */
export function getElectronAPI(): ElectronAPI | undefined {
  if (typeof window === "undefined") return undefined;
  return window.electronAPI;
}

/** True in Electron desktop app. */
export const isElectron = !!getElectronAPI()?.isElectron;

/** True in plain browser (no native shell). */
export const isWeb = !isNative && !isElectron;

/** Tor daemon and transport proxy are available on Android and Electron only. */
export const hasTor = (isAndroid || isElectron) && !isIOS;

/**
 * True when the user is on an Android device in a regular browser
 * (not inside the native Capacitor shell or a standalone PWA).
 */
export const isAndroidWeb =
  !isNative &&
  !isElectron &&
  /android/i.test(navigator.userAgent);

/** Current platform name for logging/analytics. */
export type Platform = "android" | "ios" | "electron" | "web";
export const currentPlatform: Platform = isAndroid
  ? "android"
  : isIOS
    ? "ios"
    : isElectron
      ? "electron"
      : "web";
