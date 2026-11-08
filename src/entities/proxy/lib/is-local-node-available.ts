import { isElectron, isNative } from "@/shared/lib/platform";

/**
 * Local Node Proxy talks to seed IPs (TLS :38881). Browser production hosts
 * hit CORS; Capacitor / Electron / localhost-dev can reach nodes (or a relay).
 */
export function isLocalNodeProxyAvailable(
  env: {
    isNative?: boolean;
    isElectron?: boolean;
    hostname?: string;
    forceLocalNode?: boolean;
  } = {},
): boolean {
  if (env.forceLocalNode === true) return true;
  if (env.forceLocalNode === false) return false;

  const native = env.isNative ?? isNative;
  const electron = env.isElectron ?? isElectron;
  if (native || electron) return true;

  let hostname = env.hostname;
  if (hostname == null && typeof window !== "undefined") {
    try {
      hostname = window.location?.hostname ?? "";
    } catch {
      hostname = "";
    }
  }
  return hostname === "localhost" || hostname === "127.0.0.1";
}
