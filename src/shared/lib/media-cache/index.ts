/**
 * Public API of the persistent media cache (WEE-33).
 *
 * Lifecycle: one repository per logged-in user. `initMediaCache` is called
 * from the auth login path (right after `initChatDb`), `closeMediaCache` /
 * `clearMediaCache` from logout.
 */

import { MediaCacheRepository, type MediaCacheBreakdown } from "./media-cache-repository";
import {
  DexieMediaCacheStorage,
  FilesystemMediaCacheStorage,
  type MediaCacheStorage,
} from "./media-cache-storage";
import type { ChatDatabase } from "@/shared/lib/local-db/schema";
import { isNative } from "@/shared/lib/platform";

export { MediaCacheRepository } from "./media-cache-repository";
export type {
  MediaCacheBreakdown,
  MediaCacheOptions,
  MediaCachePutMeta,
  MediaCacheRoomUsage,
  MediaCacheSnapshot,
} from "./media-cache-repository";
export type { MediaCacheCategory, MediaCacheIndexEntry } from "@/shared/lib/local-db/schema";
export {
  DexieMediaCacheStorage,
  FilesystemMediaCacheStorage,
  InMemoryMediaCacheStorage,
} from "./media-cache-storage";
export type { MediaCacheStorage } from "./media-cache-storage";

const LS_LIMIT_KEY = "bastyon-media-cache-limit-mb";
const DEFAULT_LIMIT_MB = 500;
const MIN_LIMIT_MB = 100;
const MAX_LIMIT_MB = 2000;

/** Read the user-configured cache budget from localStorage. Falls back to
 *  the 500 MB default and clamps to a sane range. */
export function getStoredCacheLimitMb(): number {
  try {
    const raw = localStorage.getItem(LS_LIMIT_KEY);
    if (!raw) return DEFAULT_LIMIT_MB;
    const parsed = parseInt(raw, 10);
    if (!Number.isFinite(parsed)) return DEFAULT_LIMIT_MB;
    return Math.min(MAX_LIMIT_MB, Math.max(MIN_LIMIT_MB, parsed));
  } catch {
    return DEFAULT_LIMIT_MB;
  }
}

/** Persist the user's chosen cache budget. Settings UI calls this when the
 *  slider releases. */
export function setStoredCacheLimitMb(mb: number): void {
  const clamped = Math.min(MAX_LIMIT_MB, Math.max(MIN_LIMIT_MB, Math.round(mb)));
  try {
    localStorage.setItem(LS_LIMIT_KEY, String(clamped));
  } catch {
    // localStorage quota exceeded / disabled — non-fatal, the budget just
    // resets to default next session.
  }
}

export { DEFAULT_LIMIT_MB, MIN_LIMIT_MB, MAX_LIMIT_MB };

// ---------------------------------------------------------------------------
// Singleton management
// ---------------------------------------------------------------------------

let currentCache: MediaCacheRepository | null = null;
let currentDb: ChatDatabase | null = null;

/** Pick the right storage backend for the current platform. Native gets
 *  Capacitor Filesystem; everything else (web, Electron, tests) uses the
 *  Dexie blob table. */
function pickStorage(db: ChatDatabase): MediaCacheStorage {
  if (isNative) return new FilesystemMediaCacheStorage();
  return new DexieMediaCacheStorage(db);
}

/** Initialise (or re-initialise) the media cache for the active user.
 *  Idempotent for the SAME `db` instance: returns the existing cache.
 *  If a different Dexie handle comes in (account switch where caller
 *  forgot to call `closeMediaCache`), discard the old singleton so the
 *  new one wraps the fresh DB instead of a torn-down handle. */
export function initMediaCache(db: ChatDatabase): MediaCacheRepository {
  if (currentCache && currentDb === db) return currentCache;
  if (currentCache && currentDb !== db) {
    // Defensive: stale singleton — drop it without clearing data.
    // The new ChatDatabase already owns its own state.
    currentCache = null;
    currentDb = null;
  }
  const limitMb = getStoredCacheLimitMb();
  const storage = pickStorage(db);
  currentCache = new MediaCacheRepository(db, storage, {
    maxBytes: limitMb * 1024 * 1024,
  });
  currentDb = db;
  return currentCache;
}

/** Return the current cache instance, or null if logged out / not yet
 *  initialised. Callers in the download path treat null as "no cache layer
 *  available" and fall back to the direct network fetch. */
export function getMediaCache(): MediaCacheRepository | null {
  return currentCache;
}

/** Wipe cache contents and tear down the singleton. Called from the auth
 *  logout flow so a subsequent user does not see prior decrypted media.
 *  Passes `permanent=true` so any in-flight writes that land mid-clear
 *  rollback their own storage entries instead of leaking on disk. */
export async function clearMediaCache(): Promise<void> {
  if (!currentCache) return;
  try { await currentCache.clearAll(true); } catch { /* swallow on logout */ }
  currentCache = null;
  currentDb = null;
}

/** Tear down without clearing — used when switching users where Dexie is
 *  about to be deleted anyway. */
export function closeMediaCache(): void {
  currentCache = null;
  currentDb = null;
}

/** Update the live cache budget AND persist the user's choice. Settings UI
 *  calls this when the slider commits. */
export async function applyCacheLimitMb(mb: number): Promise<void> {
  setStoredCacheLimitMb(mb);
  if (currentCache) {
    await currentCache.setMaxBytes(getStoredCacheLimitMb() * 1024 * 1024);
  }
}

export type { MediaCacheBreakdown as MediaCacheBreakdownSnapshot };
