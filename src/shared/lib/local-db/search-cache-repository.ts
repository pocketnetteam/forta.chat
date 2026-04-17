/**
 * Search cache repository — Dexie-backed TTL cache for user directory search results.
 *
 * Caches query → results for 1 hour to avoid hammering RPC / Matrix user_directory
 * when the user re-types the same query (debounce re-trigger, re-open of search UI).
 *
 * Keys are lower-cased to make cache lookup case-insensitive.
 */

import type { ChatDatabase } from "./schema";

/** Cache entry TTL: 1 hour (matches typical UX expectations). */
const DEFAULT_TTL_MS = 60 * 60 * 1000;

export interface CachedSearchUser {
  address: string;
  name: string;
  image?: string;
}

export interface SearchCacheEntry {
  query: string;        // PK — lower-cased
  results: CachedSearchUser[];
  expiresAt: number;    // Unix ms
}

export class SearchCacheRepository {
  constructor(private db: ChatDatabase, private ttlMs: number = DEFAULT_TTL_MS) {}

  /** Fetch cached results for a query. Returns null if missing or expired. */
  async get(query: string): Promise<CachedSearchUser[] | null> {
    const key = query.trim().toLowerCase();
    if (!key) return null;
    try {
      const row = await this.db.searchCache.get(key);
      if (!row) return null;
      if (row.expiresAt < Date.now()) {
        // Expired — fire-and-forget delete; don't block caller.
        this.db.searchCache.delete(key).catch(() => {});
        return null;
      }
      return row.results;
    } catch {
      return null;
    }
  }

  /** Store results for a query with TTL. */
  async put(query: string, results: CachedSearchUser[]): Promise<void> {
    const key = query.trim().toLowerCase();
    if (!key) return;
    try {
      await this.db.searchCache.put({
        query: key,
        results,
        expiresAt: Date.now() + this.ttlMs,
      });
    } catch {
      // Cache write failures must not break the search flow.
    }
  }

  /** Delete all cached entries (e.g. on logout). */
  async clear(): Promise<void> {
    try {
      await this.db.searchCache.clear();
    } catch {
      // ignore
    }
  }

  /** Best-effort GC for expired entries. */
  async garbageCollect(): Promise<number> {
    try {
      const now = Date.now();
      const expired = await this.db.searchCache.where("expiresAt").below(now).primaryKeys();
      if (expired.length > 0) {
        await this.db.searchCache.bulkDelete(expired);
      }
      return expired.length;
    } catch {
      return 0;
    }
  }
}
