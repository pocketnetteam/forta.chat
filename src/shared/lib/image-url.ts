/**
 * Centralized image URL normalization for Pocketnet/Bastyon images.
 *
 * Pocketnet images are hosted on peertube servers that periodically migrate.
 * The proxy provides a list of "archived" server hostnames; when an image URL
 * points to one of those old hosts, we rewrite it to the archive CDN.
 *
 * This module mirrors the pocketnet `replaceArchiveInImage` logic but in a
 * typed, testable, singleton form.
 */

const ARCHIVE_HOST = "peertube.archive.pocketnet.app";
const BASTYON_IMAGES_BASE = "https://bastyon.com/images/";

let archivedServers: string[] = [];

/** Replace the cached list of archived peertube server hostnames. */
export function setArchivedPeertubeServers(servers: string[]): void {
  archivedServers = servers;
}

/** Read-only access to the current list (useful for tests / debugging). */
export function getArchivedPeertubeServers(): readonly string[] {
  return archivedServers;
}

/**
 * Normalize a Pocketnet image URL:
 *  1. If `src` is a relative image identifier (not starting with "http"),
 *     prefix it with the Bastyon images base.
 *  2. Rewrite archived peertube server hosts → archive CDN.
 *  3. Fix known host/protocol issues (bastyon SSL, test env, double-scheme).
 *
 * Intended as a drop-in replacement for scattered `replaceArchiveInImage` /
 * `bastyon.com:8092 → pocketnet.app:8092` fixes throughout the codebase.
 */
export function normalizePocketnetImageUrl(src: string | undefined | null): string {
  if (!src) return "";

  let url = src;

  // Relative image ids → absolute Bastyon images URL
  if (!url.startsWith("http") && !url.startsWith("data:") && !url.startsWith("blob:")) {
    url = BASTYON_IMAGES_BASE + url;
  }

  // Rewrite archived peertube hosts → single archive CDN
  for (const server of archivedServers) {
    if (url.includes(server)) {
      url = url.replace(server, ARCHIVE_HOST);
    }
  }

  // Known host / protocol fixups
  url = url
    .replace("bastyon.com:8092", "pocketnet.app:8092")
    .replace("test.pocketnet", "pocketnet")
    .replace("https://http://", "http://");

  return url;
}

/**
 * Fetch the list of archived peertube servers from the proxy and cache it.
 * Endpoint: https://{proxy}/peertubeserversList
 * Response: { result: "success", data: { archivedPeertubeServers: string[] } }
 *
 * Should be called once during app initialization.
 * Returns the list on success, empty array on failure (non-critical).
 */
export async function loadArchivedPeertubeServers(
  proxyBaseUrl: string
): Promise<string[]> {
  try {
    const response = await fetch(`${proxyBaseUrl}/peertubeserversList`, {
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      console.warn("[image-url] Failed to load peertube servers list:", response.status);
      return [];
    }

    const json = await response.json();
    const servers: string[] = json?.data?.archivedPeertubeServers ?? [];

    if (Array.isArray(servers) && servers.length > 0) {
      setArchivedPeertubeServers(servers);
      console.log(`[image-url] Loaded ${servers.length} archived peertube servers`);
      return servers;
    }

    return [];
  } catch (e) {
    console.warn("[image-url] Could not load peertube servers list:", e);
    return [];
  }
}
