import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

/**
 * Regression for unclickable links inside chat messages on Capacitor Android
 * (forta-bugs #815, #351, WEE-42).
 *
 * `<a target="_blank">` does not navigate inside a Capacitor WebView because
 * Android WebView has no concept of "new tab". The fix intercepts clicks and
 * opens the URL via `@capacitor/browser` on native or `window.open` elsewhere.
 *
 * Source-level assertion mirrors MessageContextMenu-save-action.test.ts —
 * mounting MessageContent needs Pinia + parser shims, which adds a lot of
 * brittleness for what is essentially a click-handler contract.
 */
const getSource = (): string =>
  readFileSync(resolve(__dirname, "../MessageContent.vue"), "utf-8");

describe("MessageContent — link click handler", () => {
  it("imports Capacitor so it can branch on native vs web", () => {
    const source = getSource();
    expect(source).toMatch(/from\s+['"]@capacitor\/core['"]/);
    expect(source).toMatch(/\bCapacitor\b/);
  });

  it("declares a handleLinkClick handler that prevents default navigation", () => {
    const source = getSource();
    expect(source).toMatch(/function\s+handleLinkClick|const\s+handleLinkClick\s*=/);
    expect(source).toMatch(/\.preventDefault\(\)/);
  });

  it("opens links via @capacitor/browser on native platforms", () => {
    const source = getSource();
    expect(source).toMatch(/Capacitor\.isNativePlatform\(\)/);
    expect(source).toMatch(/@capacitor\/browser/);
    expect(source).toMatch(/Browser\.open/);
  });

  it("falls back to window.open with noopener on web/electron", () => {
    const source = getSource();
    expect(source).toMatch(/window\.open\([^)]*['"]_blank['"][^)]*noopener/);
  });

  it("wires the link template to the click handler instead of target=_blank", () => {
    const source = getSource();
    // Every <a> in the link branch should call handleLinkClick on click.
    const linkBranches = source.match(/seg\.type === ['"]link['"][\s\S]*?<\/a>/g) ?? [];
    expect(linkBranches.length).toBeGreaterThan(0);
    for (const branch of linkBranches) {
      expect(branch).toMatch(/@click[^=]*=\s*['"]handleLinkClick/);
      // target="_blank" alone does nothing on Capacitor — the handler is the
      // source of truth, so the attribute should be gone.
      expect(branch).not.toMatch(/target=['"]_blank['"]/);
    }
  });
});
