/**
 * Resolves blob URLs for image cache entries so the Settings → Storage
 * list can show real thumbnails instead of a generic icon.
 *
 * The composable lazy-loads each `mxc` on first reference, batches the
 * loads through Promise.allSettled so a long list doesn't fan out to
 * tens of concurrent Capacitor Filesystem reads, and revokes every
 * created object URL on scope dispose to avoid blob leaks.
 *
 * Non-image entries are intentionally not resolved — videos would need a
 * thumbnail extraction pipeline we don't have yet.
 */

import { ref, onScopeDispose, watch, type Ref } from "vue";
import { getMediaCache } from "@/shared/lib/media-cache";
import type { MediaCacheIndexEntry } from "@/shared/lib/media-cache";

const CONCURRENCY = 4;

export function useMediaThumbnails(entries: Ref<MediaCacheIndexEntry[]>) {
  /** Map mxc → blob URL. Updated reactively when new image entries arrive. */
  const thumbnails = ref<Record<string, string>>({});
  /** Track URLs we created so we can revoke each one exactly once on
   *  unmount (or when the entry disappears from the list). */
  const created = new Set<string>();
  let cancelled = false;

  const revoke = (url: string) => {
    if (!created.has(url)) return;
    try { URL.revokeObjectURL(url); } catch { /* ignore */ }
    created.delete(url);
  };

  const loadOne = async (entry: MediaCacheIndexEntry): Promise<void> => {
    if (cancelled) return;
    if (thumbnails.value[entry.mxc]) return;
    if (!entry.mime.startsWith("image/")) return;
    const cache = getMediaCache();
    if (!cache) return;
    try {
      const blob = await cache.get(entry.mxc);
      if (cancelled || !blob) return;
      const url = URL.createObjectURL(blob);
      created.add(url);
      thumbnails.value = { ...thumbnails.value, [entry.mxc]: url };
    } catch {
      // Non-fatal — the row falls back to the placeholder icon.
    }
  };

  /** Run loaders in fixed-concurrency batches so the Capacitor Filesystem
   *  layer doesn't see a thundering herd of reads. */
  const loadBatch = async (pending: MediaCacheIndexEntry[]) => {
    for (let i = 0; i < pending.length; i += CONCURRENCY) {
      if (cancelled) return;
      const slice = pending.slice(i, i + CONCURRENCY);
      await Promise.allSettled(slice.map(loadOne));
    }
  };

  /** Reconcile thumbnails with the current list: load missing images,
   *  drop URLs that no longer have a matching entry. */
  watch(entries, (next) => {
    const wanted = new Set(next.filter((e) => e.mime.startsWith("image/")).map((e) => e.mxc));
    // Revoke entries that fell out of the list (deleted from cache etc).
    for (const mxc of Object.keys(thumbnails.value)) {
      if (!wanted.has(mxc)) {
        revoke(thumbnails.value[mxc]);
        const { [mxc]: _, ...rest } = thumbnails.value;
        thumbnails.value = rest;
      }
    }
    // Kick off loaders for newly visible image entries.
    const pending = next.filter((e) => e.mime.startsWith("image/") && !thumbnails.value[e.mxc]);
    if (pending.length > 0) loadBatch(pending);
  }, { immediate: true, deep: false });

  onScopeDispose(() => {
    cancelled = true;
    for (const url of Object.values(thumbnails.value)) revoke(url);
    thumbnails.value = {};
  });

  return { thumbnails };
}
