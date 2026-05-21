/**
 * Tests for MediaCacheRepository.
 *
 * Cover the public contract:
 *  - get/put round-trip
 *  - get returns null on miss (and never throws on corrupted entries)
 *  - LRU eviction kicks in when total size exceeds maxBytes
 *  - clearAll wipes both index + storage
 *  - sizeBreakdown groups by top-level MIME category
 *  - get refreshes accessedAt so LRU does not evict the just-read item
 *  - per-room + per-category breakdown queries (WEE-33 Telegram-style UI)
 *  - deleteByRoom wipes one chat's cache
 */

import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MediaCacheRepository, type MediaCachePutMeta } from "../media-cache-repository";
import { InMemoryMediaCacheStorage } from "../media-cache-storage";
import { ChatDatabase } from "@/shared/lib/local-db/schema";

let dbCounter = 0;

function makeBlob(bytes: number, mime: string = "image/jpeg"): Blob {
  // Use a Uint8Array filled with zeros — size matters for eviction tests,
  // content does not.
  return new Blob([new Uint8Array(bytes)], { type: mime });
}

/** Convenience wrapper — most tests don't care about the meta, they
 *  exercise the size/LRU/lifecycle contract. Tests that DO care about
 *  roomId/category override the relevant fields. */
function meta(over: Partial<MediaCachePutMeta> = {}): MediaCachePutMeta {
  return {
    roomId: "!room1:server",
    category: "media",
    fileName: undefined,
    ...over,
  };
}

describe("MediaCacheRepository", () => {
  let db: ChatDatabase;
  let cache: MediaCacheRepository;

  beforeEach(async () => {
    // Each test gets its own isolated Dexie instance — fake-indexeddb is
    // process-global, so without a fresh DB name the LRU eviction tests
    // would contaminate each other.
    db = new ChatDatabase(`test-${++dbCounter}`);
    await db.open();
    cache = new MediaCacheRepository(db, new InMemoryMediaCacheStorage(), {
      maxBytes: 1_000_000,
    });
  });

  afterEach(async () => {
    await db.delete().catch(() => {});
  });

  it("returns null on miss", async () => {
    const got = await cache.get("mxc://server/never-stored");
    expect(got).toBeNull();
  });

  it("stores and retrieves a blob by mxc URI", async () => {
    const blob = makeBlob(100, "image/jpeg");
    await cache.put("mxc://server/abc", blob, meta());

    const got = await cache.get("mxc://server/abc");
    expect(got).toBeInstanceOf(Blob);
    expect(got!.size).toBe(100);
    expect(got!.type).toBe("image/jpeg");
  });

  it("overwrites an existing entry with the same key", async () => {
    await cache.put("mxc://server/x", makeBlob(100, "image/jpeg"), meta());
    await cache.put("mxc://server/x", makeBlob(200, "image/png"), meta());

    const got = await cache.get("mxc://server/x");
    expect(got!.size).toBe(200);
    expect(got!.type).toBe("image/png");

    const total = await cache.getTotalSize();
    expect(total).toBe(200);
  });

  it("evicts the least-recently-used entry when total exceeds maxBytes", async () => {
    cache = new MediaCacheRepository(db, new InMemoryMediaCacheStorage(), {
      maxBytes: 1_000_000,
    });

    await cache.put("mxc://1", makeBlob(600_000), meta());
    // Advance accessedAt resolution. Test-only injected clock would be
    // cleaner, but Date.now() ticks naturally and put writes a fresh
    // accessedAt each call — putting twice in the same microsecond would
    // still keep insertion order via the auto-incremented localId tiebreak.
    await new Promise((r) => setTimeout(r, 5));
    await cache.put("mxc://2", makeBlob(600_000), meta());

    // Total = 1.2 MB > 1 MB limit → oldest ("mxc://1") must be evicted.
    expect(await cache.get("mxc://1")).toBeNull();
    expect(await cache.get("mxc://2")).toBeInstanceOf(Blob);
  });

  it("get() refreshes accessedAt so the just-read entry survives the next eviction sweep", async () => {
    cache = new MediaCacheRepository(db, new InMemoryMediaCacheStorage(), {
      maxBytes: 1_000_000,
    });

    await cache.put("mxc://oldest", makeBlob(400_000), meta());
    await new Promise((r) => setTimeout(r, 5));
    await cache.put("mxc://middle", makeBlob(400_000), meta());
    await new Promise((r) => setTimeout(r, 5));

    // Touch "mxc://oldest" so its accessedAt jumps above "mxc://middle".
    await cache.get("mxc://oldest");
    await new Promise((r) => setTimeout(r, 5));

    // Insert a third entry that pushes total to 1.2 MB — eviction must
    // drop "mxc://middle" (least-recently-used), not "mxc://oldest".
    await cache.put("mxc://newest", makeBlob(400_000), meta());

    expect(await cache.get("mxc://oldest")).toBeInstanceOf(Blob);
    expect(await cache.get("mxc://middle")).toBeNull();
    expect(await cache.get("mxc://newest")).toBeInstanceOf(Blob);
  });

  it("clearAll() removes all entries from index and storage", async () => {
    await cache.put("mxc://a", makeBlob(100, "image/jpeg"), meta());
    await cache.put("mxc://b", makeBlob(200, "video/mp4"), meta());

    await cache.clearAll();

    expect(await cache.get("mxc://a")).toBeNull();
    expect(await cache.get("mxc://b")).toBeNull();
    expect(await cache.getTotalSize()).toBe(0);
  });

  it("sizeBreakdown() groups bytes by top-level MIME category", async () => {
    await cache.put("mxc://photo1", makeBlob(100, "image/jpeg"), meta());
    await cache.put("mxc://photo2", makeBlob(200, "image/png"), meta());
    await cache.put("mxc://video1", makeBlob(500, "video/mp4"), meta());
    await cache.put("mxc://audio1", makeBlob(50, "audio/ogg"), meta({ category: "voice" }));
    await cache.put("mxc://doc1", makeBlob(75, "application/pdf"), meta({ category: "file" }));

    const breakdown = await cache.sizeBreakdown();
    expect(breakdown.image).toBe(300);
    expect(breakdown.video).toBe(500);
    expect(breakdown.audio).toBe(50);
    expect(breakdown.other).toBe(75);
    expect(breakdown.total).toBe(925);
  });

  it("getTotalSize() returns 0 when cache is empty", async () => {
    expect(await cache.getTotalSize()).toBe(0);
  });

  it("does not crash when storage and index drift (orphan index row)", async () => {
    const storage = new InMemoryMediaCacheStorage();
    cache = new MediaCacheRepository(db, storage, { maxBytes: 1_000_000 });

    await cache.put("mxc://orphan", makeBlob(100), meta());
    // Drop the blob from storage while leaving the index intact — simulates
    // a corrupted Filesystem cache directory after the user cleared app
    // data outside the app.
    await storage.delete("mxc://orphan");

    // Read must not throw — it should self-heal by purging the dead index
    // entry and returning null.
    expect(await cache.get("mxc://orphan")).toBeNull();
  });

  it("coalesces concurrent put() calls for the same mxc", async () => {
    // Two cells racing for the same image must not produce two index rows.
    // Without coalescing, getTotalSize() would double-count the blob.
    const blob = makeBlob(100, "image/jpeg");
    await Promise.all([
      cache.put("mxc://race", blob, meta()),
      cache.put("mxc://race", blob, meta()),
      cache.put("mxc://race", blob, meta()),
    ]);

    expect(await cache.getTotalSize()).toBe(100);
    const got = await cache.get("mxc://race");
    expect(got!.size).toBe(100);
  });

  it("clearAll(permanent=true) makes subsequent put() a no-op and rolls back in-flight writes", async () => {
    const storage = new InMemoryMediaCacheStorage();
    cache = new MediaCacheRepository(db, storage, { maxBytes: 1_000_000 });

    // Land one entry first, then permanently dispose.
    await cache.put("mxc://before", makeBlob(100), meta());
    await cache.clearAll(true);

    // After permanent disposal, new puts must be ignored (the singleton
    // is effectively dead). Storage must NOT receive any new bytes.
    await cache.put("mxc://after-dispose", makeBlob(100), meta());

    expect(await cache.get("mxc://before")).toBeNull();
    expect(await cache.get("mxc://after-dispose")).toBeNull();
    expect(await storage.read("mxc://after-dispose")).toBeNull();
  });

  it("setMaxBytes() shrinks the cache to fit a smaller budget", async () => {
    await cache.put("mxc://1", makeBlob(300_000), meta());
    await new Promise((r) => setTimeout(r, 5));
    await cache.put("mxc://2", makeBlob(300_000), meta());
    await new Promise((r) => setTimeout(r, 5));
    await cache.put("mxc://3", makeBlob(300_000), meta());

    // Lower limit to 500 KB — must keep only the most recently used.
    await cache.setMaxBytes(500_000);

    expect(await cache.get("mxc://1")).toBeNull();
    expect(await cache.get("mxc://2")).toBeNull();
    expect(await cache.get("mxc://3")).toBeInstanceOf(Blob);
  });

  // ---------------------------------------------------------------------------
  // WEE-33 Telegram-style breakdown queries
  // ---------------------------------------------------------------------------

  it("breakdownByRoom() groups bytes by room, sorted by total descending", async () => {
    await cache.put("mxc://a", makeBlob(100), meta({ roomId: "!small:s" }));
    await cache.put("mxc://b", makeBlob(300), meta({ roomId: "!big:s", category: "media" }));
    await cache.put("mxc://c", makeBlob(50),  meta({ roomId: "!big:s", category: "voice" }));
    await cache.put("mxc://d", makeBlob(200), meta({ roomId: "!mid:s", category: "file" }));

    const rooms = await cache.breakdownByRoom();
    expect(rooms.map((r) => r.roomId)).toEqual(["!big:s", "!mid:s", "!small:s"]);

    const big = rooms.find((r) => r.roomId === "!big:s")!;
    expect(big.totalBytes).toBe(350);
    expect(big.byCategory.media).toBe(300);
    expect(big.byCategory.voice).toBe(50);
    expect(big.byCategory.file).toBe(0);
    expect(big.count).toBe(2);
  });

  it("listByCategory() returns only entries of the asked category, newest first", async () => {
    await cache.put("mxc://photo", makeBlob(100, "image/jpeg"), meta({ category: "media" }));
    await new Promise((r) => setTimeout(r, 5));
    await cache.put("mxc://pdf",   makeBlob(200, "application/pdf"), meta({ category: "file" }));
    await new Promise((r) => setTimeout(r, 5));
    await cache.put("mxc://voice", makeBlob(50,  "audio/webm"), meta({ category: "voice" }));
    await new Promise((r) => setTimeout(r, 5));
    await cache.put("mxc://video", makeBlob(500, "video/mp4"), meta({ category: "media" }));

    const mediaList = await cache.listByCategory("media");
    expect(mediaList.map((e) => e.mxc)).toEqual(["mxc://video", "mxc://photo"]);

    const fileList = await cache.listByCategory("file");
    expect(fileList.map((e) => e.mxc)).toEqual(["mxc://pdf"]);

    const voiceList = await cache.listByCategory("voice");
    expect(voiceList.map((e) => e.mxc)).toEqual(["mxc://voice"]);
  });

  it("deleteByRoom() wipes every entry for a single chat and leaves others", async () => {
    await cache.put("mxc://x1", makeBlob(100), meta({ roomId: "!keep:s" }));
    await cache.put("mxc://x2", makeBlob(200), meta({ roomId: "!drop:s" }));
    await cache.put("mxc://x3", makeBlob(300), meta({ roomId: "!drop:s" }));

    const removed = await cache.deleteByRoom("!drop:s");
    expect(removed).toBe(2);

    expect(await cache.get("mxc://x1")).toBeInstanceOf(Blob);
    expect(await cache.get("mxc://x2")).toBeNull();
    expect(await cache.get("mxc://x3")).toBeNull();
    expect(await cache.getTotalSize()).toBe(100);
  });
});
