import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * The soft-keyboard contract of the `.safe-*` utilities.
 *
 * Neither WebView resizes when the keyboard opens — on Android MainActivity is
 * edge-to-edge and returns `WindowInsetsCompat.CONSUMED`, on iOS the Keyboard
 * plugin runs with `resize: 'none'` — so the blocks that hold a text field have
 * to make room themselves from the injected variables. Only those blocks move;
 * the root shell stays `position: fixed; inset: 0`.
 *
 * Android's `--keyboardheight` is the IME MINUS the nav bar, while the IME
 * covers the nav bar too, so a container padded by it ends up short by the nav
 * bar's height. `--app-bottom-inset` (max of IME and nav bar) is the value that
 * is correct on both platforms.
 *
 * The rules live in a stylesheet whose `max()` over custom properties no
 * headless DOM resolves, so this pins the contract in source the way
 * `SafeAreaInjectionContractTest` pins the injected script.
 */

const root = resolve(__dirname, "../../..");
const read = (p: string) => readFileSync(resolve(root, p), "utf-8");

const mainCss = read("src/app/styles/main.css");
const appVue = read("src/app/App.vue");

function ruleBody(css: string, selector: string): string {
  const at = css.indexOf(`\n  ${selector} {`);
  expect(at, `${selector} must exist in main.css`).toBeGreaterThanOrEqual(0);
  const open = css.indexOf("{", at);
  return css.slice(open + 1, css.indexOf("}", open));
}

const KEYBOARD_PADDING =
  /padding-bottom:\s*max\(\s*var\(--app-bottom-inset[^)]*\)\s*,\s*var\(--safe-area-inset-bottom[^)]*\)\s*\)/;

describe("keyboard inset utilities", () => {
  it.each([".safe-bottom", ".safe-y", ".safe-all"])(
    "%s pads its container by the keyboard inset",
    (selector) => {
      expect(ruleBody(mainCss, selector)).toMatch(KEYBOARD_PADDING);
    },
  );

  it("uses --app-bottom-inset, never --keyboardheight, for that padding", () => {
    // --keyboardheight excludes the nav bar on Android; padding by it would
    // leave the composer covered by the nav bar's height of keyboard.
    for (const selector of [".safe-bottom", ".safe-y", ".safe-all"]) {
      expect(ruleBody(mainCss, selector)).not.toContain("--keyboardheight");
    }
  });

  it("keeps .pb-safe keyboard-free for bottom sheets", () => {
    // A sheet is not a text-field container; padding every one of them by the
    // keyboard would move sheets that have nothing to reveal.
    const pbSafe = ruleBody(mainCss, ".pb-safe");
    expect(pbSafe).toContain("var(--safe-area-inset-bottom");
    expect(pbSafe).not.toContain("--app-bottom-inset");
    expect(pbSafe).not.toContain("--keyboardheight");
  });

  it("keeps one cross-platform rule instead of an iOS-only override", () => {
    // Android and iOS publish --app-bottom-inset with the same meaning
    // (`MainActivity.injectAllCssVars` / `useIOSKeyboardCssVar`), so a
    // `.is-ios`-scoped padding override would only be able to disagree.
    expect(mainCss).not.toMatch(/\.is-ios\s+\.safe-/);
  });

  it("leaves the root shell pinned to the viewport", () => {
    // Moving the whole shell would relayout and repaint the entire app for a
    // problem that belongs to the input containers.
    const template = appVue.slice(appVue.indexOf("<template>") + 10);
    const firstDiv = template.slice(
      template.indexOf("<div"),
      template.indexOf(">") + 1,
    );
    expect(firstDiv).toContain("fixed inset-0");
  });
});
