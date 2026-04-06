import { describe, it, expect } from "vitest";
import { computeKeyboardHeight, shouldScrollIntoView } from "./keyboard-height";

describe("computeKeyboardHeight", () => {
  const base = { baseInnerHeight: 800 };

  it("returns native kbh for native events", () => {
    const result = computeKeyboardHeight(base, {
      isNativeEvent: true,
      nativeKbh: 280,
      webKbh: 0,
      innerHeight: 800,
    });
    expect(result.kbh).toBe(280);
  });

  it("native event bypasses anti-double-push even when innerHeight shrank", () => {
    const result = computeKeyboardHeight(base, {
      isNativeEvent: true,
      nativeKbh: 280,
      webKbh: 0,
      innerHeight: 520, // shrank by 280 — adjustResize active
    });
    // Should still return 280, not 0
    expect(result.kbh).toBe(280);
  });

  it("anti-double-push zeroes kbh for non-native event when innerHeight shrank", () => {
    const result = computeKeyboardHeight(base, {
      isNativeEvent: false,
      nativeKbh: 0,
      webKbh: 280,
      innerHeight: 520,
    });
    expect(result.kbh).toBe(0);
  });

  it("uses max(webKbh, nativeKbh) for non-native events", () => {
    const result = computeKeyboardHeight(base, {
      isNativeEvent: false,
      nativeKbh: 250,
      webKbh: 280,
      innerHeight: 800,
    });
    expect(result.kbh).toBe(280);
  });

  it("updates baseline when keyboard closes (kbh=0)", () => {
    const result = computeKeyboardHeight(base, {
      isNativeEvent: false,
      nativeKbh: 0,
      webKbh: 0,
      innerHeight: 900, // orientation changed
    });
    expect(result.kbh).toBe(0);
    expect(result.baseInnerHeight).toBe(900);
  });

  it("does not trigger anti-double-push for small innerHeight changes (<50px)", () => {
    const result = computeKeyboardHeight(base, {
      isNativeEvent: false,
      nativeKbh: 0,
      webKbh: 280,
      innerHeight: 770, // only 30px change, below threshold
    });
    expect(result.kbh).toBe(280);
  });
});

describe("shouldScrollIntoView", () => {
  it("returns true for plain INPUT", () => {
    const el = document.createElement("input");
    expect(shouldScrollIntoView(el)).toBe(true);
  });

  it("returns true for plain TEXTAREA", () => {
    const el = document.createElement("textarea");
    expect(shouldScrollIntoView(el)).toBe(true);
  });

  it("returns true for contentEditable div", () => {
    const el = document.createElement("div");
    el.contentEditable = "true";
    expect(shouldScrollIntoView(el)).toBe(true);
  });

  it("returns false for element with data-keyboard-aware", () => {
    const el = document.createElement("textarea");
    el.dataset.keyboardAware = "";
    expect(shouldScrollIntoView(el)).toBe(false);
  });

  it("returns false for non-input elements", () => {
    const el = document.createElement("div");
    expect(shouldScrollIntoView(el)).toBe(false);
  });
});
