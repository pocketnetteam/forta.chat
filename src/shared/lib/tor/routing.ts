/**
 * Shared Tor routing logic for Electron and Capacitor Android.
 *
 * Both platforms register a Service Worker that asks the renderer whether to
 * route a URL through Tor. Whitelist checks happen here before delegating to
 * platform-specific AUTO / ALWAYS logic (native plugin on Android, IPC on Electron).
 *
 * ## Port layout (intentional divergence)
 *
 * Application-level HTTP reverse proxy is the same on both platforms:
 * `http://127.0.0.1:8181/{encodeURIComponent(url)}`
 *
 * SOCKS ports differ because each stack runs its own Tor daemon:
 * - Android (libtor.so): SOCKS **9051**, Control **9251**
 * - Electron (proxy16): SOCKS **9250**
 *
 * Only the HTTP proxy port (8181) is used by the Service Worker and Matrix axios proxy.
 */

export const TOR_HTTP_PROXY_HOST = '127.0.0.1';
export const TOR_HTTP_PROXY_PORT = 8181;

/** Android native SOCKS port (libtor). */
export const TOR_SOCKS_PORT_ANDROID = 9051;

/** Electron proxy16 SOCKS port. */
export const TOR_SOCKS_PORT_ELECTRON = 9250;

/** Hosts that always use a direct connection (never Tor). Shared with Cordova whitelist. */
export const TRANSPORT_WHITELIST: RegExp[] = [
  /\.?youtube\.com$/,
  /\.?imgur\.com$/,
  /\.?cdn\.jsdelivr\.net$/,
  /\.?vimeocdn\.com$/,
  /\.?vimeo\.com$/,
  /photos\.brighteon\.com$/,
];

export function isWhitelistedHost(hostname: string): boolean {
  return TRANSPORT_WHITELIST.some((re) => re.test(hostname));
}

export function isWhitelistedUrl(url: string): boolean {
  try {
    return isWhitelistedHost(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** Build reverse-proxy URL used by Capacitor SW and Matrix axios proxy. */
export function buildTorProxyUrl(
  originalUrl: string,
  port: number = TOR_HTTP_PROXY_PORT,
): string {
  return `http://${TOR_HTTP_PROXY_HOST}:${port}/${encodeURIComponent(originalUrl)}`;
}

/**
 * Decide whether a request should be routed through Tor.
 *
 * Whitelisted CDN hosts always return false (direct).
 * All other URLs are delegated to platform logic via `resolvePlatformDecision`:
 * - Android: torService.isUseWithTor() → TorPlugin native AUTO ping
 * - Electron: IPC AltTransportActive → proxy16 transports.isTorNeeded()
 */
export async function shouldRouteThroughTor(
  url: string,
  resolvePlatformDecision: (url: string) => Promise<boolean>,
): Promise<boolean> {
  if (isWhitelistedUrl(url)) {
    return false;
  }

  return resolvePlatformDecision(url);
}
