import { LOCAL_NODE_CONSTANTS } from "./constants";
import type { SeedMeta } from "./types";

const { WEB_PORT, SECURE_WEB_PORT, WS_PORT, SECURE_WS_PORT } = LOCAL_NODE_CONSTANTS;

function seed(host: string): SeedMeta {
  return {
    host,
    port: WEB_PORT,
    sport: SECURE_WEB_PORT,
    ws: WS_PORT,
    sws: SECURE_WS_PORT,
    name: host,
    stable: true,
    allowRpc: true,
  };
}

/** Mainnet trust seeds (mirrors proxy16/kit.js activenodes subset). */
export const ACTIVE_SEEDS: readonly SeedMeta[] = [
  seed("202.61.253.55"),
  seed("207.180.201.246"),
  seed("5.189.141.204"),
  seed("162.246.52.155"),
  seed("95.31.45.162"),
  seed("79.143.35.233"),
  seed("109.197.196.106"),
  seed("178.217.159.221"),
  seed("128.69.178.18"),
  seed("85.175.4.178"),
  seed("178.234.11.26"),
  seed("5.187.79.252"),
];

export function getTrustSeeds(): SeedMeta[] {
  return ACTIVE_SEEDS.map((s) => ({ ...s, key: `${s.host}:${s.port}` }));
}
