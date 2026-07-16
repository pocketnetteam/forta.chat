import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

/**
 * Regression for WEE-88 (forta-bugs#990, #986).
 *
 * The SENDER could not play their own voice/audio message: either an eternal
 * loading spinner (#990) or audible-to-peer-but-silent-to-self (#986). The
 * receiver always heard it fine.
 *
 * Root cause: `seedLocalUrl` wrote the optimistic `blob:` URL into the
 * long-lived module `cache`. After `confirmMediaSent`, the blob is revoked
 * (~5s, sync-engine), but the cache entry survived. The post-confirm
 * `watch → download()` in VoiceMessage.vue then short-circuited on
 * `cache.has()` and handed the player a DEAD blob URL — spinner / silent.
 *
 * The fix has two parts, asserted here at the source level (mounting
 * VoiceMessage.vue would drag in the audio singleton + file-download + Dexie
 * stack; the behavioural contract is covered in use-file-download.test.ts):
 *
 *   1. `seedLocalUrl` seeds ONLY the per-instance state, never `cache`.
 *   2. VoiceMessage.vue invalidates the cache on the blob→mxc transition so
 *      download() re-fetches the durable server copy.
 */

const voiceMessageSource = (): string =>
  readFileSync(resolve(__dirname, "../VoiceMessage.vue"), "utf-8");

const fileDownloadSource = (): string =>
  readFileSync(resolve(__dirname, "../../model/use-file-download.ts"), "utf-8");

/** Extract the body of the `seedLocalUrl` arrow function. */
const seedLocalUrlBody = (): string => {
  const src = fileDownloadSource();
  const start = src.indexOf("const seedLocalUrl =");
  expect(start, "seedLocalUrl must exist in use-file-download.ts").toBeGreaterThan(-1);
  // The function ends at the first `};` after its declaration.
  const end = src.indexOf("};", start);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
};

describe("VoiceMessage — own voice playback (WEE-88)", () => {
  it("seedLocalUrl seeds only the instance state, never the long-lived cache", () => {
    const body = seedLocalUrlBody();
    // The blob must NOT be written to the module `cache` — that is precisely
    // the poisoning that left the sender replaying a revoked blob.
    expect(body).not.toMatch(/cache\.set\(/);
    // It still seeds the reactive per-instance state so pending playback works.
    expect(body).toContain("state.objectUrl");
  });

  it("still seeds the local blob for a pending voice message (instant playback)", () => {
    const src = voiceMessageSource();
    // onMounted seeds the live blob when the message is still sending.
    expect(src).toContain("seedLocalUrl(fileCacheKey.value, url)");
    expect(src).toMatch(/isPending\.value && url\.startsWith\("blob:"\)/);
  });

  it("invalidates the download cache on the blob→server URL transition", () => {
    const src = voiceMessageSource();
    expect(src).toContain("invalidateDownloadCache");
    // The invalidation must sit inside the fileInfo.url watch, guarded on the
    // non-blob (confirmed) URL, immediately before the re-download.
    const watchStart = src.indexOf("() => props.message.fileInfo?.url");
    expect(watchStart, "url watch must exist").toBeGreaterThan(-1);
    const watchSlice = src.slice(watchStart, watchStart + 600);
    expect(watchSlice).toContain('!newUrl.startsWith("blob:")');
    expect(watchSlice).toContain("invalidateDownloadCache(fileCacheKey.value)");
    expect(watchSlice).toContain("download(props.message)");
  });

  it("imports invalidateDownloadCache from the download composable", () => {
    const src = voiceMessageSource();
    expect(src).toMatch(
      /import\s*\{[^}]*invalidateDownloadCache[^}]*\}\s*from\s*["']\.\.\/model\/use-file-download["']/,
    );
  });
});
