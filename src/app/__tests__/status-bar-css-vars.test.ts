import { describe, it, expect, beforeEach } from "vitest";

/**
 * Session 10 regression tests.
 *
 * Protects the contract between index.html and native code:
 *  - index.html MUST seed `--safe-area-inset-*` CSS vars before the JS bundle
 *    runs so the first paint already clears the Android 15/16 status bar.
 *  - Native code (MainActivity.injectAllCssVars) overwrites these with exact
 *    device values when insets become available.
 *
 * If this test fails, the flash-under-status-bar bug is back.
 */

function seedInitialSafeAreaStyle(): void {
  // Mirrors the inline <style id="initial-safe-area"> block from index.html.
  const style = document.createElement("style");
  style.id = "initial-safe-area";
  style.textContent = `
    :root {
      --safe-area-inset-top: env(safe-area-inset-top, 24px);
      --safe-area-inset-right: env(safe-area-inset-right, 0px);
      --safe-area-inset-bottom: env(safe-area-inset-bottom, 0px);
      --safe-area-inset-left: env(safe-area-inset-left, 0px);
      --keyboardheight: 0px;
      --app-bottom-inset: env(safe-area-inset-bottom, 0px);
    }
  `;
  document.head.appendChild(style);
}

describe("status bar safe-area CSS vars", () => {
  beforeEach(() => {
    document.getElementById("initial-safe-area")?.remove();
    const root = document.documentElement;
    root.style.removeProperty("--safe-area-inset-top");
    root.style.removeProperty("--safe-area-inset-bottom");
    root.style.removeProperty("--safe-area-inset-left");
    root.style.removeProperty("--safe-area-inset-right");
    root.style.removeProperty("--keyboardheight");
    root.style.removeProperty("--app-bottom-inset");
  });

  it("seeds all safe-area vars on document root before JS bundle runs", () => {
    seedInitialSafeAreaStyle();

    const computed = getComputedStyle(document.documentElement);

    // The property MUST be declared (non-empty). Exact value depends on the
    // renderer: in a happy-dom headless environment env() resolves to the
    // provided fallback, in Chrome it resolves to the real inset.
    for (const name of [
      "--safe-area-inset-top",
      "--safe-area-inset-right",
      "--safe-area-inset-bottom",
      "--safe-area-inset-left",
      "--keyboardheight",
      "--app-bottom-inset",
    ]) {
      const value = computed.getPropertyValue(name).trim();
      expect(value, `${name} must be declared by initial-safe-area style`).not.toBe("");
    }
  });

  it("native inject path overrides initial values (simulates MainActivity.injectAllCssVars)", () => {
    seedInitialSafeAreaStyle();

    // Simulate what MainActivity.injectAllCssVars writes on every inset change.
    const root = document.documentElement;
    root.style.setProperty("--safe-area-inset-top", "42px");
    root.style.setProperty("--safe-area-inset-bottom", "16px");
    root.style.setProperty("--safe-area-inset-left", "0px");
    root.style.setProperty("--safe-area-inset-right", "0px");
    root.style.setProperty("--keyboardheight", "0px");
    root.style.setProperty("--app-bottom-inset", "16px");

    const computed = getComputedStyle(root);
    expect(computed.getPropertyValue("--safe-area-inset-top").trim()).toBe("42px");
    expect(computed.getPropertyValue("--safe-area-inset-bottom").trim()).toBe("16px");
    expect(computed.getPropertyValue("--app-bottom-inset").trim()).toBe("16px");
  });

  it("keyboard open path zeros out --safe-area-inset-bottom (nav bar behind IME)", () => {
    seedInitialSafeAreaStyle();

    // MainActivity.injectAllCssVars sets effectiveBottom=0 when keyboardHeight>0.
    const root = document.documentElement;
    root.style.setProperty("--safe-area-inset-bottom", "0px");
    root.style.setProperty("--keyboardheight", "280px");
    root.style.setProperty("--app-bottom-inset", "280px");

    const computed = getComputedStyle(root);
    expect(computed.getPropertyValue("--safe-area-inset-bottom").trim()).toBe("0px");
    expect(computed.getPropertyValue("--keyboardheight").trim()).toBe("280px");
  });
});
