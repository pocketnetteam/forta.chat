/**
 * Centralized image URL normalization for Pocketnet/Bastyon images.
 *
 * Archived peertube hosts are listed by the proxy; when a URL points to one of
 * those hosts, we rewrite it to the archive CDN (same idea as pocketnet
 * `replaceArchiveInImage`).
 */

const ARCHIVE_HOST = "peertube.archive.pocketnet.app";
const BASTYON_IMAGES_BASE = "https://bastyon.com/images/";

let archivedServers: string[] = [];

/** Replace the cached list of archived peertube server hostnames. */
export function setArchivedPeertubeServers(servers: string[]): void {
  archivedServers = servers;
}

/** Read-only access to the current list (tests / debugging). */
export function getArchivedPeertubeServers(): readonly string[] {
  return archivedServers;
}

/**
 * Normalize a Pocketnet image URL: relative ids → bastyon images base,
 * archived peertube hosts → archive CDN, known host/protocol fixups.
 */
export function normalizePocketnetImageUrl(src: string | undefined | null): string {
  if (!src) return "";

  let url = src;

  if (!url.startsWith("http") && !url.startsWith("data:") && !url.startsWith("blob:")) {
    url = BASTYON_IMAGES_BASE + url;
  }

  for (const server of archivedServers) {
    if (url.includes(server)) {
      url = url.replace(server, ARCHIVE_HOST);
    }
  }

  url = url
    .replace("bastyon.com:8092", "pocketnet.app:8092")
    .replace("test.pocketnet", "pocketnet")
    .replace("https://http://", "http://");

  return url;
}

/**
 * Fetch archived peertube server hostnames from the proxy.
 * GET {proxyBaseUrl}/peertubeserversList
 * Response: { result: "success", data: { archivedPeertubeServers: string[] } }
 */
export async function loadArchivedPeertubeServers(proxyBaseUrl: string): Promise<string[]> {
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
