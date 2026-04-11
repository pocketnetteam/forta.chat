/**
 * In-memory blob URL cache for avatar images.
 *
 * RecycleScroller reuses DOM nodes, so when the user scrolls up/down the chat
 * list, `<img src>` flips between URLs.  If the server doesn't return proper
 * Cache-Control headers the browser re-fetches them every time.  By converting
 * each URL to a local blob: URL we guarantee a single network hit per avatar.
 */

const blobCache = new Map<string, string>();
const inflight = new Map<string, Promise<string>>();

const MAX_ENTRIES = 500;
const REVOKE_DELAY_MS = 10_000;

export function getCachedAvatarUrl(url: string): string {
  return blobCache.get(url) ?? url;
}

export function isAvatarCached(url: string): boolean {
  return blobCache.has(url);
}

/**
 * Remove a stale cache entry (e.g. when a blob URL was revoked externally
 * or the `<img>` fired an error on it).  Allows `prefetchAvatar` to re-fetch.
 */
export function invalidateCachedAvatar(url: string): void {
  const blob = blobCache.get(url);
  if (blob) {
    blobCache.delete(url);
    setTimeout(() => URL.revokeObjectURL(blob), REVOKE_DELAY_MS);
  }
}

/**
 * Fetch the image, store as blob URL.  Resolves with the blob URL on success
 * or the original URL on any error (CORS, network, etc.).
 */
export function prefetchAvatar(url: string): Promise<string> {
  if (!url) return Promise.resolve(url);
  if (blobCache.has(url)) return Promise.resolve(blobCache.get(url)!);
  if (inflight.has(url)) return inflight.get(url)!;

  const promise = fetch(url)
    .then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.blob();
    })
    .then((blob) => {
      if (blobCache.size >= MAX_ENTRIES) {
        const oldest = blobCache.keys().next().value!;
        const oldBlob = blobCache.get(oldest);
        blobCache.delete(oldest);
        if (oldBlob) setTimeout(() => URL.revokeObjectURL(oldBlob), REVOKE_DELAY_MS);
      }
      const blobUrl = URL.createObjectURL(blob);
      blobCache.set(url, blobUrl);
      return blobUrl;
    })
    .catch(() => url)
    .finally(() => {
      inflight.delete(url);
    });

  inflight.set(url, promise);
  return promise;
}
