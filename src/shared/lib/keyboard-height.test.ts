import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  computeKeyboardHeight,
  shouldScrollIntoView,
  KeyboardHeightManager,
  isOccludedByKeyboard,
} from "./keyboard-height";

describe("computeKeyboardHeight", () => {
  it("returns native kbh for native events", () => {
    expect(computeKeyboardHeight({ isNativeEvent: true, nativeKbh: 280, webKbh: 0 })).toBe(280);
  });

  it("returns native kbh=0 when keyboard closes via native event", () => {
    expect(computeKeyboardHeight({ isNativeEvent: true, nativeKbh: 0, webKbh: 100 })).toBe(0);
  });

  it("uses max(webKbh, nativeKbh) for non-native events", () => {
    expect(computeKeyboardHeight({ isNativeEvent: false, nativeKbh: 250, webKbh: 280 })).toBe(280);
    expect(computeKeyboardHeight({ isNativeEvent: false, nativeKbh: 300, webKbh: 280 })).toBe(300);
  });

  it("returns 0 when both values are 0", () => {
    expect(computeKeyboardHeight({ isNativeEvent: false, nativeKbh: 0, webKbh: 0 })).toBe(0);
  });

  it("handles negative webKbh gracefully (takes max with nativeKbh)", () => {
    // visualViewport can sometimes report height > innerHeight briefly
    expect(computeKeyboardHeight({ isNativeEvent: false, nativeKbh: 0, webKbh: -10 })).toBe(0);
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

// ── KeyboardHeightManager ──

describe("KeyboardHeightManager", () => {
  let mgr: KeyboardHeightManager;
  const T0 = 1000000;

  beforeEach(() => {
    mgr = new KeyboardHeightManager();
  });

  it("accepts native updates and records height + source", () => {
    const h = mgr.update("native", { isNativeEvent: true, nativeKbh: 280, webKbh: 0 }, T0);
    expect(h).toBe(280);
    expect(mgr.currentHeight).toBe(280);
    expect(mgr.lastSource).toBe("native");
  });

  it("suppresses web updates within the lock window after native", () => {
    mgr.update("native", { isNativeEvent: true, nativeKbh: 280, webKbh: 0 }, T0);

    // 50ms later — within 120ms lock
    const h = mgr.update("visualViewport", { isNativeEvent: false, nativeKbh: 280, webKbh: 260 }, T0 + 50);
    expect(h).toBeNull();
    expect(mgr.currentHeight).toBe(280);
    expect(mgr.lastSource).toBe("native");
  });

  it("accepts web updates after the lock window expires", () => {
    mgr.update("native", { isNativeEvent: true, nativeKbh: 280, webKbh: 0 }, T0);

    // 150ms later — lock expired
    const h = mgr.update("visualViewport", { isNativeEvent: false, nativeKbh: 280, webKbh: 300 }, T0 + 150);
    expect(h).toBe(300);
    expect(mgr.currentHeight).toBe(300);
    expect(mgr.lastSource).toBe("visualViewport");
  });

  it("always accepts native updates even during lock", () => {
    mgr.update("native", { isNativeEvent: true, nativeKbh: 280, webKbh: 0 }, T0);
    const h = mgr.update("native", { isNativeEvent: true, nativeKbh: 310, webKbh: 0 }, T0 + 30);
    expect(h).toBe(310);
    expect(mgr.currentHeight).toBe(310);
  });

  it("isNativeLocked returns correct state", () => {
    expect(mgr.isNativeLocked(T0)).toBe(false);
    mgr.update("native", { isNativeEvent: true, nativeKbh: 280, webKbh: 0 }, T0);
    expect(mgr.isNativeLocked(T0 + 50)).toBe(true);
    expect(mgr.isNativeLocked(T0 + 119)).toBe(true);
    expect(mgr.isNativeLocked(T0 + 120)).toBe(false);
  });

  it("reset clears all state", () => {
    mgr.update("native", { isNativeEvent: true, nativeKbh: 280, webKbh: 0 }, T0);
    mgr.reset();
    expect(mgr.currentHeight).toBe(0);
    expect(mgr.lastSource).toBe("native");
    expect(mgr.isNativeLocked(T0 + 10)).toBe(false);
  });

  it("virtualKeyboard source is also suppressed during lock", () => {
    mgr.update("native", { isNativeEvent: true, nativeKbh: 280, webKbh: 0 }, T0);
    const h = mgr.update("virtualKeyboard", { isNativeEvent: false, nativeKbh: 280, webKbh: 270 }, T0 + 60);
    expect(h).toBeNull();
  });

  it("handles keyboard close: native=0 clears height", () => {
    mgr.update("native", { isNativeEvent: true, nativeKbh: 280, webKbh: 0 }, T0);
    const h = mgr.update("native", { isNativeEvent: true, nativeKbh: 0, webKbh: 100 }, T0 + 500);
    expect(h).toBe(0);
    expect(mgr.currentHeight).toBe(0);
  });
});

// ── isOccludedByKeyboard ──

describe("isOccludedByKeyboard", () => {
  const makeEl = (bottom: number): HTMLElement => {
    const el = document.createElement("input");
    vi.spyOn(el, "getBoundingClientRect").mockReturnValue({
      bottom,
      top: bottom - 40,
      left: 0,
      right: 300,
      width: 300,
      height: 40,
      x: 0,
      y: bottom - 40,
      toJSON: () => ({}),
    });
    return el;
  };

  it("returns false when keyboard height is 0", () => {
    const el = makeEl(700);
    expect(isOccludedByKeyboard(el, 0)).toBe(false);
  });

  it("returns true when element bottom is below visible area", () => {
    // innerHeight=800, keyboard=300 → visible bottom = 800-300-10 = 490
    vi.stubGlobal("innerHeight", 800);
    const el = makeEl(600);
    expect(isOccludedByKeyboard(el, 300)).toBe(true);
  });

  it("returns false when element is above keyboard", () => {
    vi.stubGlobal("innerHeight", 800);
    const el = makeEl(400);
    expect(isOccludedByKeyboard(el, 300)).toBe(false);
  });

  it("returns true when element is right at the edge (within margin)", () => {
    // visible bottom = 800-300-10 = 490; element bottom = 495 → occluded
    vi.stubGlobal("innerHeight", 800);
    const el = makeEl(495);
    expect(isOccludedByKeyboard(el, 300)).toBe(true);
  });

  it("returns false when element is just above threshold", () => {
    // visible bottom = 800-300-10 = 490; element bottom = 489 → not occluded
    vi.stubGlobal("innerHeight", 800);
    const el = makeEl(489);
    expect(isOccludedByKeyboard(el, 300)).toBe(false);
  });
});
