import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

/**
 * Android shrinks the window for the soft keyboard (MainActivity pads the
 * content view by the IME inset), so the caption bar must not add
 * --keyboardheight there: it lifted a second time and floated a keyboard's
 * height above the keyboard (Samsung, 2026-09-29). iOS does not resize the
 * WebView and still needs the padding. CSS scoping cannot run in jsdom, so
 * this pins the rules in source.
 */
const source = readFileSync(resolve(__dirname, "../MediaPreview.vue"), "utf-8");

describe("MediaPreview caption bar keyboard padding", () => {
  it("adds the keyboard height on iOS only", () => {
    const style = source.slice(source.indexOf("<style scoped>"));
    const base = style.match(/\.caption-bar\s*\{([^}]*)\}/)?.[1] ?? "";
    const ios = style.match(/:global\(\.is-ios\)\s*\.caption-bar\s*\{([^}]*)\}/)?.[1] ?? "";

    expect(base).toContain("--safe-area-inset-bottom");
    expect(base).not.toContain("--keyboardheight");
    expect(ios).toContain("--keyboardheight");
  });

  it("keeps no inline keyboard padding on the bar", () => {
    const template = source.slice(0, source.indexOf("<style scoped>"));
    expect(template).toContain('class="caption-bar');
    expect(template).not.toMatch(/style="[^"]*--keyboardheight/);
  });
});
