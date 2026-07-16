import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

/**
 * WEE-25 regression suite — confirmation toast + in-flight guard across all
 * three save-to-gallery entry points.
 *
 * Source: forta-bugs#780 (no toast), #758 (5 taps = 5 dupes), #753 (audio),
 * #281 (profile save without feedback).
 *
 * Source-level asserts keep this test trivial to run in CI without mounting
 * the full Vue + Pinia + native plugin tree. Mirrors the pattern used by
 * MediaViewer-save-button.test.ts and MessageContextMenu-save-action.test.ts.
 */
const read = (rel: string): string =>
  readFileSync(resolve(__dirname, rel), "utf-8");

describe("WEE-25 / MediaViewer — in-flight guard", () => {
  const source = read("../MediaViewer.vue");

  it("declares a saving ref next to currentIndex", () => {
    expect(source).toMatch(/const\s+saving\s*=\s*ref\(false\)/);
  });

  it("early-returns from handleSaveCurrent when a save is already running", () => {
    const fnStart = source.indexOf("const handleSaveCurrent");
    expect(fnStart).toBeGreaterThan(-1);
    const fnEnd = source.indexOf("\n};", fnStart);
    const fn = source.slice(fnStart, fnEnd);
    expect(fn).toMatch(/if\s*\(\s*saving\.value\s*\)\s*return/);
    expect(fn).toMatch(/saving\.value\s*=\s*true/);
    expect(fn).toMatch(/saving\.value\s*=\s*false/);
  });

  it("disables the save button while saving is true", () => {
    const start = source.indexOf('data-testid="media-save"');
    expect(start).toBeGreaterThan(-1);
    const fragment = source.slice(start, start + 500);
    expect(fragment).toMatch(/:disabled="!currentUrl \|\| saving"/);
  });
});

describe("WEE-25 / MessageBubble — file/audio save toast + guard", () => {
  const source = read("../MessageBubble.vue");

  it("imports useToast", () => {
    expect(source).toMatch(/import\s*\{\s*useToast\s*\}\s*from\s*"@\/shared\/lib\/use-toast"/);
  });

  it("caches toast at setup top-level (not after await inside handler)", () => {
    // The Vue "composables must run during setup, not after await" invariant
    // is enforced at the call site — handleFileDownload uses the cached
    // reference instead of re-entering useToast() post-await.
    expect(source).toMatch(/const\s*\{\s*toast(\s*:\s*\w+)?\s*\}\s*=\s*useToast\(\)/);
  });

  it("declares an isSavingFile ref", () => {
    expect(source).toMatch(/const\s+isSavingFile\s*=\s*ref\(false\)/);
  });

  it("handleFileDownload wires toast on success and error and is guarded", () => {
    const fnStart = source.indexOf("const handleFileDownload");
    expect(fnStart).toBeGreaterThan(-1);
    const fnEnd = source.indexOf("\n};", fnStart);
    const fn = source.slice(fnStart, fnEnd);
    expect(fn).toMatch(/if\s*\(\s*isSavingFile\.value\s*\)\s*return/);
    expect(fn).toMatch(/isSavingFile\.value\s*=\s*true/);
    expect(fn).toMatch(/isSavingFile\.value\s*=\s*false/);
    // Success branch: must call the cached toast reference (alias `showToast`
    // or destructured `toast`) with the savedToGallery/Downloads key.
    expect(fn).toMatch(/\b(showToast|toast)\(.*media\.savedTo(Gallery|Downloads)/);
    expect(fn).toMatch(/\b(showToast|toast)\(.*media\.saveFailed.*"error"/);
    // Audio messages travel through the same file/audio download path —
    // not branching on mime here means audio files now save through the
    // same flow as PDFs, archives, etc. (forta-bugs#753).
    expect(fn).toContain("saveFile");
  });

  it("disables the file save button while isSavingFile is true", () => {
    expect(source).toMatch(/:disabled="isSavingFile"/);
  });
});

describe("WEE-25 / MessageList — context-menu save guard", () => {
  const source = read("../MessageList.vue");

  it("uses a per-cacheKey in-flight Set to dedupe long-press → Save", () => {
    expect(source).toMatch(/savingInFlight\s*=\s*new\s+Set<string>\(\)/);
  });

  it("handleSaveMedia early-returns when the same cacheKey is in flight", () => {
    const fnStart = source.indexOf("const handleSaveMedia");
    expect(fnStart).toBeGreaterThan(-1);
    const fnEnd = source.indexOf("\n};", fnStart);
    const fn = source.slice(fnStart, fnEnd);
    expect(fn).toMatch(/savingInFlight\.has\(cacheKey\)/);
    expect(fn).toMatch(/savingInFlight\.add\(cacheKey\)/);
    expect(fn).toMatch(/savingInFlight\.delete\(cacheKey\)/);
  });
});

describe("WEE-25 / SaveMediaPlugin — audio mime support (Android)", () => {
  // Kotlin source is checked into the JS tree under android/. Reading it
  // here keeps audio-mime routing in the regression net so a future
  // refactor of the native plugin can't silently strip Music/* routing
  // (forta-bugs#753).
  const source = readFileSync(
    resolve(__dirname, "../../../../../android/app/src/main/java/com/forta/chat/plugins/savemedia/SaveMediaPlugin.kt"),
    "utf-8",
  );

  it("routes audio/* mime to the Music collection on API 29+", () => {
    expect(source).toMatch(/mime\.startsWith\("audio\/"\)\s*->\s*\n?\s*MediaStore\.Audio\.Media\.getContentUri/);
  });

  it("routes audio/* mime to DIRECTORY_MUSIC on legacy storage", () => {
    expect(source).toMatch(/mime[Tt]ype\.startsWith\("audio\/"\)\s*->\s*Environment\.DIRECTORY_MUSIC/);
  });

  it("maps audio/* to a Music/Forta Chat relative path", () => {
    expect(source).toMatch(/"audio\/".*->\s*"Music\/Forta Chat"/s);
  });
});
