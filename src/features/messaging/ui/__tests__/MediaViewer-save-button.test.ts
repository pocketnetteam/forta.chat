import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

/**
 * Regression for missing "Save to gallery" affordance (issues #676, #376,
 * #331, #158).
 *
 * Users expected a visible save button when viewing a photo/video — the
 * MediaViewer top-bar previously only had close + counter, leaving the
 * existing useFileDownload.saveFile path unreachable from photo/video
 * messages. This test guards the wiring between the top-bar button and the
 * download composable so a future refactor can't quietly remove it.
 *
 * Source-level assertion mirrors the pattern in
 * message-bubble-decrypt-error-ux.test.ts: mounting MediaViewer requires
 * mocking the chat store, useFileDownload, AndroidBackHandler and video
 * state preservation, which is brittle relative to the one-line wiring we
 * actually want to verify.
 */
const getSource = (): string =>
  readFileSync(resolve(__dirname, "../MediaViewer.vue"), "utf-8");

describe("MediaViewer — save-to-gallery button", () => {
  it("renders a save button identified by data-testid='media-save'", () => {
    const source = getSource();
    expect(source).toMatch(/data-testid="media-save"/);
  });

  it("disables the save button when there is no current url", () => {
    const source = getSource();
    // The button must guard against missing media so a stray click during
    // download (currentUrl === null) does not invoke saveFile with null.
    const start = source.indexOf('data-testid="media-save"');
    expect(start).toBeGreaterThan(-1);
    const fragment = source.slice(start, start + 500);
    expect(fragment).toMatch(/:disabled="!currentUrl"/);
  });

  it("wires the save button click to a handler that calls saveFile", () => {
    const source = getSource();
    // Pull saveFile out of useFileDownload alongside the existing getState/download.
    expect(source).toMatch(/const\s*\{\s*[^}]*\bsaveFile\b[^}]*\}\s*=\s*useFileDownload\(\)/);
    // The handler invoked by the button must call saveFile with the current
    // url + filename + mime.
    const fnStart = source.indexOf("const handleSaveCurrent");
    expect(fnStart).toBeGreaterThan(-1);
    const fnEnd = source.indexOf("};", fnStart);
    const fn = source.slice(fnStart, fnEnd);
    expect(fn).toContain("saveFile");
    expect(fn).toContain("currentUrl");
    expect(fn).toContain("fileInfo");
  });

  it("uses media.save i18n key for the title/aria label", () => {
    const source = getSource();
    expect(source).toContain("media.save");
  });
});
