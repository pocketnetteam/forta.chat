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

/**
 * Return a cached blob URL if available, otherwise the original URL.
 * Always call `prefetchAvatar` first (or in parallel) to start caching.
 */
export function getCachedAvatarUrl(url: string): string {
  return blobCache.get(url) ?? url;
}

export function isAvatarCached(url: string): boolean {
  return blobCache.has(url);
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
        if (oldBlob) URL.revokeObjectURL(oldBlob);
        blobCache.delete(oldest);
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
