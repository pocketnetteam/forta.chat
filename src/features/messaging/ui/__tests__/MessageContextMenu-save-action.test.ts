import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

/**
 * Regression for missing "Save" entry in the message long-press / right-click
 * menu for photo and video messages (issues #676, #376, #331, #158).
 *
 * Long-pressing a photo bubble previously offered reply/copy/forward/etc but
 * not save. The MediaViewer save button (Task 2) covers the in-viewer flow,
 * but users who long-press without opening the viewer also need a path to
 * trigger useFileDownload.saveFile.
 *
 * Source-level assertion mirrors message-bubble-decrypt-error-ux.test.ts —
 * mounting MessageContextMenu requires Pinia, BottomSheet's portal, useMobile
 * matchMedia, and the i18n stub, which is brittle for what amounts to
 * verifying one menu item and one switch case.
 */
const getMenuSource = (): string =>
  readFileSync(resolve(__dirname, "../MessageContextMenu.vue"), "utf-8");
const getListSource = (): string =>
  readFileSync(resolve(__dirname, "../MessageList.vue"), "utf-8");

describe("MessageContextMenu — save action for image/video", () => {
  it("includes a 'save' action in menuItems guarded by an image/video check", () => {
    const source = getMenuSource();
    // The action key must be exactly "save" so the parent switch in
    // MessageList matches.
    expect(source).toMatch(/action:\s*['"]save['"]/);
    // The save entry must only appear for image or video messages with file
    // info — otherwise the menu would offer Save on text/poll/transfer items
    // where it would just no-op.
    expect(source).toMatch(/MessageType\.image|message\.type === ['"]image['"]/);
    expect(source).toMatch(/MessageType\.video|message\.type === ['"]video['"]/);
  });

  it("declares a save icon under ICONS so the menu renders consistently", () => {
    const source = getMenuSource();
    expect(source).toMatch(/save:\s*svg\(/);
  });

  it("uses media.save i18n key for the save menu label", () => {
    const source = getMenuSource();
    expect(source).toContain("media.save");
  });
});

describe("MessageList — save action wires to useFileDownload.saveFile", () => {
  it("destructures saveFile + download from useFileDownload", () => {
    const source = getListSource();
    expect(source).toMatch(/\bsaveFile\b/);
    expect(source).toMatch(/useFileDownload\(\)/);
  });

  it("handles the 'save' action by downloading (if needed) and calling saveFile", () => {
    const source = getListSource();
    // Find the handleContextAction switch and confirm a 'save' branch exists.
    const fnStart = source.indexOf("const handleContextAction");
    expect(fnStart).toBeGreaterThan(-1);
    const fnEnd = source.indexOf("\n};", fnStart);
    const fn = source.slice(fnStart, fnEnd);
    expect(fn).toMatch(/case\s+['"]save['"]/);
    // The save branch may either inline saveFile or delegate to a helper —
    // either way, saveFile must be reachable from this file.
    expect(source).toContain("saveFile");
    // Ensure we honour cache-key parity with MessageBubble (use _key || id)
    // so we don't kick off a duplicate decrypt for media that's already
    // displayed in the bubble.
    expect(source).toMatch(/_key\s*\|\|\s*[\w.]+\.id/);
  });
});
