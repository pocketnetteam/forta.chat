import type { TorBridgeType, TorMode } from "../model/types";

export const TOR_MODE_CYCLE: readonly TorMode[] = ["neveruse", "auto", "always"];

export function getNextTorMode(current: TorMode): TorMode {
  const idx = TOR_MODE_CYCLE.indexOf(current);
  const nextIdx = idx < 0 ? 0 : (idx + 1) % TOR_MODE_CYCLE.length;
  return TOR_MODE_CYCLE[nextIdx];
}

export function fromNativeBridgeType(value: string): TorBridgeType {
  return value.toUpperCase() === "SNOWFLAKE" ? "snowflake" : "none";
}

export function toNativeBridgeType(bridge: TorBridgeType): string {
  return bridge === "snowflake" ? "SNOWFLAKE" : "NONE";
}

/**
 * Bastyon parity: auto-enable Snowflake in regions that commonly block Tor dirs.
 * Checks app locale and browser language (fa is not a Forta UI locale yet).
 */
export function shouldAutoEnableSnowflake(
  appLocale: string,
  browserLang: string = typeof navigator !== "undefined" ? navigator.language : "",
): boolean {
  const lang = (browserLang || "").toLowerCase();
  if (appLocale === "ru" || appLocale === "fa") return true;
  return lang.startsWith("ru") || lang.startsWith("fa");
}

/**
 * When enabling Tor from "neveruse", optionally pick Snowflake for censored locales.
 */
export function resolveBridgeOnEnable(
  previousMode: TorMode,
  newMode: TorMode,
  currentBridge: TorBridgeType,
  appLocale: string,
  browserLang?: string,
): TorBridgeType {
  if (previousMode !== "neveruse" || newMode === "neveruse") {
    return currentBridge;
  }
  if (currentBridge !== "none") {
    return currentBridge;
  }
  return shouldAutoEnableSnowflake(appLocale, browserLang) ? "snowflake" : currentBridge;
}
