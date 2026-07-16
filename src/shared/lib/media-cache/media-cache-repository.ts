/**
 * Persistent media cache repository — Telegram/WhatsApp-style disk cache for
 * decrypted Matrix media (WEE-33).
 *
 * Architecture:
 *   - Index lives in Dexie (`mediaCacheIndex` table) for O(1) PK lookup and
 *     ordered-by-`accessedAt` scans during LRU eviction.
 *   - Blob bytes live in {@link MediaCacheStorage}: Capacitor Filesystem on
 *     native, Dexie on web/Electron, in-memory in tests.
 *   - Eviction is **size-budget LRU**: oldest `accessedAt` wins. The budget
 *     is configurable per-user via Settings → Storage.
 *
 * Security note: cache stores PLAINTEXT decrypted blobs. The Filesystem
 * backend writes to `Directory.Cache`, which is app-private sandbox on both
 * iOS and Android — acceptable per platform. On logout, `clearAll()` must
 * be called by the auth flow so a subsequent user does not see prior
 * media leaking out of cache.
 */

import type { ChatDatabase, MediaCacheIndexEntry, MediaCacheCategory } from "@/shared/lib/local-db/schema";
import type { MediaCacheStorage } from "./media-cache-storage";

export interface MediaCacheOptions {
  /** Soft cap on total cached bytes. LRU eviction runs after every `put()`
   *  to bring total back under this number. */
  maxBytes: number;
}

/** Per-write metadata that powers the Settings → Storage breakdown UI.
 *  Required so the Telegram-style per-chat / per-category lists have
 *  the data they need without re-classifying each blob at render time. */
export interface MediaCachePutMeta {
  /** Matrix room ID the message came from — drives the "Чаты" tab. */
  roomId: string;
  /** Top-level grouping for the Storage tabs (media / file / voice). */
  category: MediaCacheCategory;
  /** Original filename, used in the Files / Voice list rows. Optional
   *  because images/videos rarely have a user-facing name. */
  fileName?: string;
}

/** Aggregate sizes grouped by top-level MIME category. Used by the
 *  Settings → Storage screen to render the breakdown bars. */
export interface MediaCacheBreakdown {
  image: number;
  video: number;
  audio: number;
  other: number;
  total: number;
}

/** Per-room aggregate row for the "Чаты" tab. */
export interface MediaCacheRoomUsage {
  roomId: string;
  totalBytes: number;
  /** Per-category byte counts inside this room so the row can show a
   *  small stacked bar (media / file / voice) without a second query. */
  byCategory: Record<MediaCacheCategory, number>;
  /** Number of cached entries — useful for "5 files" subtitle. */
  count: number;
}

/** Single-pass snapshot powering the Settings → Storage screen. All
 *  derived views share one `toArray()` instead of 4-5 redundant scans
 *  per refresh tick — important when the index grows to thousands of
 *  rows on low-end Android. */
export interface MediaCacheSnapshot {
  breakdown: MediaCacheBreakdown;
  byRoom: MediaCacheRoomUsage[];
  byCategory: Record<MediaCacheCategory, MediaCacheIndexEntry[]>;
}

const DEFAULT_MAX_BYTES = 500 * 1024 * 1024; // 500 MB — Telegram default

export class MediaCacheRepository {
  private maxBytes: number;
  /** In-flight `put()` promises keyed by mxc. Two cells rendering the same
   *  image concurrently (e.g. message list + reply preview) would otherwise
   *  both miss the cache, both download, and both write — inflating the
   *  index size counter and triggering premature LRU eviction. Coalescing
   *  on `mxc` lets the second caller await the first's write. */
  private readonly inflight = new Map<string, Promise<void>>();
  /** Once `clearAll()` runs the singleton is considered disposed — any
   *  in-flight `put()` that lands AFTER the clear must be a no-op,
   *  otherwise it would leak the just-cleared user's plaintext blob onto
   *  disk where a subsequent user could read it. Set/cleared by
   *  `clearAll()` so the cache can be re-initialised cleanly. */
  private disposed = false;

  constructor(
    private readonly db: ChatDatabase,
    private readonly storage: MediaCacheStorage,
    opts: MediaCacheOptions = { maxBytes: DEFAULT_MAX_BYTES },
  ) {
    this.maxBytes = Math.max(0, opts.maxBytes);
  }

  /** Resolve a cached blob for `mxc`. Returns null on miss, on corrupted
   *  entries (storage and index drifted apart), or if the underlying
   *  Dexie/Filesystem call throws — callers fall back to the network path.
   *
   *  Side effect: refreshes `accessedAt` so the read pushes the entry to
   *  the head of the LRU queue. We swallow write errors here — a stale
   *  accessedAt only affects future eviction ordering, never correctness. */
  async get(mxc: string): Promise<Blob | null> {
    let entry: MediaCacheIndexEntry | undefined;
    try {
      entry = await this.db.mediaCacheIndex.get(mxc);
    } catch {
      return null;
    }
    if (!entry) return null;

    const blob = await this.storage.read(mxc);
    if (!blob) {
      // Storage and index drifted (user wiped cache dir, Filesystem failure,
      // etc.). Self-heal so the index doesn't keep flagging a phantom hit.
      try { await this.db.mediaCacheIndex.delete(mxc); } catch { /* ignore */ }
      return null;
    }

    // Touch accessedAt — best-effort, errors here don't affect the read.
    try {
      await this.db.mediaCacheIndex.update(mxc, { accessedAt: Date.now() });
    } catch { /* ignore */ }

    // Preserve the original MIME — Capacitor's base64 round-trip loses
    // it, so we re-stamp from the index entry which knows the truth.
    if (blob.type === entry.mime) return blob;
    return new Blob([blob], { type: entry.mime });
  }

  /** Store `blob` under `mxc`, then enforce the size budget. Errors during
   *  the storage write surface to the caller (so `useFileDownload` knows
   *  the cache write didn't take), but failures during the eviction sweep
   *  are swallowed — a temporary overage is acceptable.
   *
   *  Concurrent calls for the same `mxc` coalesce: the second caller
   *  awaits the first's promise instead of writing again. */
  async put(mxc: string, blob: Blob, meta: MediaCachePutMeta): Promise<void> {
    if (this.disposed) return;
    const existingFlight = this.inflight.get(mxc);
    if (existingFlight) return existingFlight;

    const work = this.doPut(mxc, blob, meta).finally(() => {
      this.inflight.delete(mxc);
    });
    this.inflight.set(mxc, work);
    return work;
  }

  private async doPut(mxc: string, blob: Blob, meta: MediaCachePutMeta): Promise<void> {
    await this.storage.write(mxc, blob);
    // The cache might have been disposed (logout) while the storage write
    // was in flight. Skip the index update AND roll back the storage write,
    // otherwise we'd leave a plaintext blob on disk for the next user.
    if (this.disposed) {
      try { await this.storage.delete(mxc); } catch { /* ignore */ }
      return;
    }

    const now = Date.now();
    const existing = await this.db.mediaCacheIndex.get(mxc).catch(() => undefined);
    await this.db.mediaCacheIndex.put({
      mxc,
      size: blob.size,
      mime: blob.type || "application/octet-stream",
      accessedAt: now,
      createdAt: existing?.createdAt ?? now,
      roomId: meta.roomId,
      category: meta.category,
      fileName: meta.fileName,
    });

    try {
      await this.enforceLimit();
    } catch {
      // Eviction failure is non-fatal: next put() will retry, and a
      // transient overage doesn't break any user-facing behaviour.
    }
  }

  /** Drop a single entry from index + storage. Idempotent. */
  async delete(mxc: string): Promise<void> {
    try { await this.db.mediaCacheIndex.delete(mxc); } catch { /* ignore */ }
    try { await this.storage.delete(mxc); } catch { /* ignore */ }
  }

  /** Wipe both the index and the underlying storage. Called by the
   *  Settings → "Clear cache" button (user-initiated) and by the auth
   *  `logout` flow.
   *
   *  Logout safety: marks the repository as disposed BEFORE the wipe so
   *  in-flight `put()` calls bail out (and rollback the storage write
   *  that already landed). Then awaits any inflight promises to drain,
   *  so a Filesystem write mid-`writeFile` can finish and its own
   *  disposed-guard then deletes the file.
   *
   *  @param permanent  When `true` (logout / account-switch), leave
   *    `disposed = true` permanently — any subsequent stray callers
   *    holding a reference to this instance get a no-op. The auth flow
   *    then nulls the singleton via `closeMediaCache`. When `false`
   *    (user-initiated "Clear cache" button), re-arm the cache so future
   *    writes from the same session work again. */
  async clearAll(permanent: boolean = false): Promise<void> {
    this.disposed = true;
    const drains = Array.from(this.inflight.values());
    if (drains.length > 0) {
      await Promise.allSettled(drains);
    }
    try { await this.db.mediaCacheIndex.clear(); } catch { /* ignore */ }
    try { await this.storage.clear(); } catch { /* ignore */ }
    if (!permanent) this.disposed = false;
  }

  /** Sum of `size` across all index entries. Cheap full-table scan — the
   *  index is bounded by `maxBytes` / avg-blob-size (typically <1000 rows
   *  even at the 500 MB default). */
  async getTotalSize(): Promise<number> {
    const entries = await this.db.mediaCacheIndex.toArray().catch(() => []);
    return entries.reduce((sum, e) => sum + e.size, 0);
  }

  /** Group total size by top-level MIME category. Anything outside
   *  image/video/audio falls under `other` (PDFs, archives, unknown). */
  async sizeBreakdown(): Promise<MediaCacheBreakdown> {
    const entries = await this.db.mediaCacheIndex.toArray().catch(() => []);
    const out: MediaCacheBreakdown = {
      image: 0,
      video: 0,
      audio: 0,
      other: 0,
      total: 0,
    };
    for (const e of entries) {
      const top = e.mime.split("/")[0]?.toLowerCase() ?? "";
      if (top === "image") out.image += e.size;
      else if (top === "video") out.video += e.size;
      else if (top === "audio") out.audio += e.size;
      else out.other += e.size;
      out.total += e.size;
    }
    return out;
  }

  /** Aggregate cached bytes per room, sorted by total descending.
   *  Powers the Settings → Storage "Чаты" tab. One full-table scan
   *  is enough — the index is bounded by maxBytes / avg-blob-size. */
  async breakdownByRoom(): Promise<MediaCacheRoomUsage[]> {
    const entries = await this.db.mediaCacheIndex.toArray().catch(() => []);
    const byRoom = new Map<string, MediaCacheRoomUsage>();

    for (const e of entries) {
      // v15 rows wiped in the v16 migration, but defensively coerce
      // anything legacy that slipped through to a sentinel bucket so
      // the UI can at least surface it instead of crashing on undefined.
      const roomId = e.roomId ?? "unknown";
      const category: MediaCacheCategory = e.category ?? "file";

      const usage = byRoom.get(roomId) ?? {
        roomId,
        totalBytes: 0,
        byCategory: { media: 0, file: 0, voice: 0 },
        count: 0,
      };
      usage.totalBytes += e.size;
      usage.byCategory[category] += e.size;
      usage.count += 1;
      byRoom.set(roomId, usage);
    }

    return Array.from(byRoom.values()).sort((a, b) => b.totalBytes - a.totalBytes);
  }

  /** All entries in a given category, sorted by `createdAt` descending
   *  so the most recent appears first in the per-tab list. */
  async listByCategory(category: MediaCacheCategory): Promise<MediaCacheIndexEntry[]> {
    const entries = await this.db.mediaCacheIndex
      .where("category")
      .equals(category)
      .toArray()
      .catch(() => []);
    return entries.sort((a, b) => b.createdAt - a.createdAt);
  }

  /** All entries belonging to one room. Used by the per-chat detail
   *  view (drill-down from the Чаты tab). */
  async listByRoom(roomId: string): Promise<MediaCacheIndexEntry[]> {
    const entries = await this.db.mediaCacheIndex
      .where("roomId")
      .equals(roomId)
      .toArray()
      .catch(() => []);
    return entries.sort((a, b) => b.createdAt - a.createdAt);
  }

  /** Drop every cached blob belonging to `roomId` — used when the user
   *  taps "Clear chat cache" on a single chat in the Чаты tab. Returns
   *  the number of entries removed for UI feedback.
   *
   *  Uses Dexie `bulkDelete` for the index (one IDB write per N rows
   *  instead of N writes) and parallelises storage deletes via
   *  `Promise.allSettled` — at 1k entries this drops wall time from
   *  ~seconds to a single round-trip + IO concurrency. */
  async deleteByRoom(roomId: string): Promise<number> {
    const entries = await this.db.mediaCacheIndex
      .where("roomId")
      .equals(roomId)
      .toArray()
      .catch(() => []);
    if (entries.length === 0) return 0;
    const keys = entries.map((e) => e.mxc);
    try { await this.db.mediaCacheIndex.bulkDelete(keys); } catch { /* ignore */ }
    await Promise.allSettled(keys.map((mxc) => this.storage.delete(mxc)));
    return entries.length;
  }

  /** Build the full Settings → Storage snapshot in a single Dexie scan.
   *  Callers that need breakdown + per-room + per-category lists should
   *  prefer this over chaining separate queries — it cuts IDB round-trips
   *  and main-thread JS work proportionally. */
  async snapshot(): Promise<MediaCacheSnapshot> {
    const entries = await this.db.mediaCacheIndex.toArray().catch(() => []);

    const breakdown: MediaCacheBreakdown = {
      image: 0, video: 0, audio: 0, other: 0, total: 0,
    };
    const byRoom = new Map<string, MediaCacheRoomUsage>();
    const byCategory: Record<MediaCacheCategory, MediaCacheIndexEntry[]> = {
      media: [], file: [], voice: [],
    };

    for (const e of entries) {
      // MIME bucket for the top bars
      const top = e.mime.split("/")[0]?.toLowerCase() ?? "";
      if (top === "image") breakdown.image += e.size;
      else if (top === "video") breakdown.video += e.size;
      else if (top === "audio") breakdown.audio += e.size;
      else breakdown.other += e.size;
      breakdown.total += e.size;

      // Per-room aggregation
      const roomId = e.roomId ?? "unknown";
      const category: MediaCacheCategory = e.category ?? "file";
      const usage = byRoom.get(roomId) ?? {
        roomId,
        totalBytes: 0,
        byCategory: { media: 0, file: 0, voice: 0 },
        count: 0,
      };
      usage.totalBytes += e.size;
      usage.byCategory[category] += e.size;
      usage.count += 1;
      byRoom.set(roomId, usage);

      // Per-category list (collected first, sorted below)
      byCategory[category].push(e);
    }

    // Sort: rooms by total desc, category lists by createdAt desc.
    const rooms = Array.from(byRoom.values()).sort((a, b) => b.totalBytes - a.totalBytes);
    for (const list of Object.values(byCategory)) {
      list.sort((a, b) => b.createdAt - a.createdAt);
    }

    return { breakdown, byRoom: rooms, byCategory };
  }

  /** Current size budget in bytes. */
  getMaxBytes(): number {
    return this.maxBytes;
  }

  /** Update the size budget and immediately shrink the cache to fit.
   *  Used by Settings → Storage slider. */
  async setMaxBytes(bytes: number): Promise<void> {
    this.maxBytes = Math.max(0, bytes);
    await this.enforceLimit().catch(() => { /* see put() */ });
  }

  /** LRU eviction sweep: while total > maxBytes, drop the oldest-accessed
   *  entry from both index and storage. Index is scanned ordered by the
   *  `accessedAt` index so the inner loop stays O(evicted-count). */
  private async enforceLimit(): Promise<void> {
    if (this.maxBytes <= 0) {
      // Pathological budget — clear the whole cache. Preserve the current
      // disposed flag so an eviction triggered mid-logout doesn't re-arm
      // the cache to accept writes again.
      await this.clearAll(this.disposed);
      return;
    }

    let total = await this.getTotalSize();
    if (total <= this.maxBytes) return;

    // orderBy uses the indexed `accessedAt` column → ascending = oldest first.
    const oldestFirst = await this.db.mediaCacheIndex
      .orderBy("accessedAt")
      .toArray()
      .catch(() => []);

    for (const entry of oldestFirst) {
      if (total <= this.maxBytes) break;
      try { await this.db.mediaCacheIndex.delete(entry.mxc); } catch { /* ignore */ }
      try { await this.storage.delete(entry.mxc); } catch { /* ignore */ }
      total -= entry.size;
    }
  }
}
