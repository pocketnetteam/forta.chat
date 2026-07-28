import { Capacitor } from "@capacitor/core";
import type { ElectronAPI } from "@/shared/types/electron";

export { resolveAppUpdaterEnabled } from "./resolve-app-updater-enabled";

/** True when running inside a native Capacitor shell (Android/iOS). */
export const isNative = Capacitor.isNativePlatform();

/** True on Android specifically. */
export const isAndroid = Capacitor.getPlatform() === "android";

/** True on iOS specifically. */
export const isIOS = Capacitor.getPlatform() === "ios";

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
