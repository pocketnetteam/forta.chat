/**
 * Storage backend for {@link MediaCacheRepository}.
 *
 * The repository owns the metadata index and LRU bookkeeping; storage is a
 * dumb key/value blob store. Two production implementations exist:
 *
 *  - `DexieMediaCacheStorage` (web / Electron / Capacitor fallback) — keeps
 *    blobs in the existing Dexie database under the `mediaCacheBlobs` table.
 *  - `FilesystemMediaCacheStorage` (native) — writes blobs to Capacitor
 *    `Directory.Cache`. The OS handles backup exclusion and reclaims this
 *    directory under storage pressure.
 *
 *  - `InMemoryMediaCacheStorage` is a test-only impl used by unit tests so
 *    they don't have to spin up Dexie/Filesystem just to validate the
 *    repository's LRU and breakdown logic.
 */

import type { ChatDatabase } from "@/shared/lib/local-db/schema";

export interface MediaCacheStorage {
  /** Read blob bytes for `key`. Returns null if the key is absent OR if
   *  the backend reports a corrupted/unreadable entry (the repository
   *  treats both as a miss and self-heals by purging the index row). */
  read(key: string): Promise<Blob | null>;

  /** Write `blob` under `key`, overwriting any prior entry. */
  write(key: string, blob: Blob): Promise<void>;

  /** Remove `key` if present. Must be idempotent. */
  delete(key: string): Promise<void>;

  /** Drop every entry. Used by `clearAll` and on logout. */
  clear(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Dexie-backed storage (web / Electron / Capacitor fallback)
// ---------------------------------------------------------------------------

/** Persists blobs in the `mediaCacheBlobs` Dexie table. Suitable for web,
 *  Electron, and as the Capacitor fallback when the Filesystem plugin is
 *  unavailable (e.g. running under Vitest, or an older platform shim). */
export class DexieMediaCacheStorage implements MediaCacheStorage {
  constructor(private readonly db: ChatDatabase) {}

  async read(key: string): Promise<Blob | null> {
    try {
      const row = await this.db.mediaCacheBlobs.get(key);
      return row?.blob ?? null;
    } catch {
      return null;
    }
  }

  async write(key: string, blob: Blob): Promise<void> {
    await this.db.mediaCacheBlobs.put({ mxc: key, blob });
  }

  async delete(key: string): Promise<void> {
    await this.db.mediaCacheBlobs.delete(key);
  }

  async clear(): Promise<void> {
    await this.db.mediaCacheBlobs.clear();
  }
}

// ---------------------------------------------------------------------------
// In-memory storage (tests)
// ---------------------------------------------------------------------------

/** Test-only storage that keeps blobs in a Map. Lets unit tests exercise
 *  the repository without a real Dexie or Capacitor backend. */
export class InMemoryMediaCacheStorage implements MediaCacheStorage {
  private readonly store = new Map<string, Blob>();

  async read(key: string): Promise<Blob | null> {
    return this.store.get(key) ?? null;
  }

  async write(key: string, blob: Blob): Promise<void> {
    this.store.set(key, blob);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async clear(): Promise<void> {
    this.store.clear();
  }
}

// ---------------------------------------------------------------------------
// Capacitor Filesystem storage (native)
// ---------------------------------------------------------------------------

/** Deterministic, filesystem-safe key derived from the mxc URI. The Matrix
 *  spec allows `_` and `-` in media IDs but Capacitor's Filesystem on
 *  Android has historically choked on `:` and `/`. We collapse the URI to
 *  a base64url-style hash that's safe across iOS / Android / web shims. */
function pathFor(key: string): string {
  // Polyfill-friendly: btoa is available in browsers and Capacitor WebViews.
  const safe = (typeof btoa === "function" ? btoa(key) : Buffer.from(key, "utf-8").toString("base64"))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
  return `media-cache/${safe}`;
}

async function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result as string;
      // Strip "data:...;base64," prefix.
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error("FileReader failed"));
    reader.readAsDataURL(blob);
  });
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  // Allocate an explicit ArrayBuffer (not SharedArrayBuffer) so the result
  // is a valid BlobPart under strict lib.dom.d.ts typings.
  const buf = new ArrayBuffer(binary.length);
  const view = new Uint8Array(buf);
  for (let i = 0; i < binary.length; i++) view[i] = binary.charCodeAt(i);
  return buf;
}

/** Persists blobs to Capacitor's `Directory.Cache`. Lazy-imports the
 *  Filesystem plugin so this module remains tree-shakeable on web. */
export class FilesystemMediaCacheStorage implements MediaCacheStorage {
  // We re-import on demand instead of caching the module to avoid keeping
  // a stale reference if the bridge is torn down mid-session (rare, but
  // observed on hot-reload during dev).
  private async fs() {
    const { Filesystem, Directory } = await import("@capacitor/filesystem");
    return { Filesystem, Directory };
  }

  async read(key: string): Promise<Blob | null> {
    try {
      const { Filesystem, Directory } = await this.fs();
      const result = await Filesystem.readFile({
        path: pathFor(key),
        directory: Directory.Cache,
      });
      const data = typeof result.data === "string" ? result.data : "";
      if (!data) return null;
      // Filesystem.readFile returns base64 (or Blob on web, but Capacitor
      // standardises to base64 on native — handle both).
      if (result.data instanceof Blob) return result.data;
      return new Blob([base64ToArrayBuffer(data)]);
    } catch {
      // File missing or unreadable — treat as cache miss.
      return null;
    }
  }

  async write(key: string, blob: Blob): Promise<void> {
    const { Filesystem, Directory } = await this.fs();
    const base64 = await blobToBase64(blob);
    await Filesystem.writeFile({
      path: pathFor(key),
      data: base64,
      directory: Directory.Cache,
      recursive: true,
    });
  }

  async delete(key: string): Promise<void> {
    try {
      const { Filesystem, Directory } = await this.fs();
      await Filesystem.deleteFile({
        path: pathFor(key),
        directory: Directory.Cache,
      });
    } catch {
      // Already gone — idempotent by contract.
    }
  }

  async clear(): Promise<void> {
    try {
      const { Filesystem, Directory } = await this.fs();
      await Filesystem.rmdir({
        path: "media-cache",
        directory: Directory.Cache,
        recursive: true,
      });
    } catch {
      // Directory may not exist yet — that's fine.
    }
    // Also sweep the StoragePreview temp directory. `StoragePreview` writes
    // blobs there before handing them to FileOpener, and eagerly deletes
    // each one on its own unmount. If anything went wrong (FileOpener
    // crash, app force-killed mid-view) a stale file could remain — and
    // on logout we cannot let plaintext documents survive across users.
    try {
      const { Filesystem, Directory } = await this.fs();
      await Filesystem.rmdir({
        path: "media-cache-preview",
        directory: Directory.Cache,
        recursive: true,
      });
    } catch {
      // Same rationale — never created or already swept.
    }
  }
}
