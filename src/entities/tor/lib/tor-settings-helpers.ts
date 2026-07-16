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
