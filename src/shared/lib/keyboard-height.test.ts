import { describe, it, expect, beforeEach } from "vitest";
import { computeKeyboardHeight, shouldScrollIntoView } from "./keyboard-height";

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

describe("computeKeyboardHeight — Samsung hysteresis", () => {
  beforeEach(() => {
    // Reset module-level lastNativeKbh to 0 by sending a native event with height=0.
    // This ensures each test starts from a clean state.
    computeKeyboardHeight({ isNativeEvent: true, nativeKbh: 0, webKbh: 0 });
  });

  it("holds prior native value when non-native event fires near-zero after large native value (Samsung stale scroll)", () => {
    // Prime: native keyboard opened at 280px
    computeKeyboardHeight({ isNativeEvent: true, nativeKbh: 280, webKbh: 0 });
    // Samsung stale visualViewport fires with webKbh=44 before native-keyboard-change height=0 arrives
    const result = computeKeyboardHeight({ isNativeEvent: false, nativeKbh: 0, webKbh: 44 });
    expect(result).toBe(280);
  });

  it("returns correct webKbh after native event already zeroed (hysteresis cleared)", () => {
    // Prime: native keyboard opened at 280px
    computeKeyboardHeight({ isNativeEvent: true, nativeKbh: 280, webKbh: 0 });
    // Native event fires first with height=0 — clears hysteresis
    computeKeyboardHeight({ isNativeEvent: true, nativeKbh: 0, webKbh: 0 });
    // Now visualViewport fires with stale webKbh=44 — hysteresis is cleared, returns candidate
    const result = computeKeyboardHeight({ isNativeEvent: false, nativeKbh: 0, webKbh: 44 });
    expect(result).toBe(44);
  });

  it("allows upward increase — does not block webKbh > lastNativeKbh", () => {
    // Prime: native keyboard opened at 280px
    computeKeyboardHeight({ isNativeEvent: true, nativeKbh: 280, webKbh: 0 });
    // visualViewport reports 290 (slightly larger) — this is a legitimate increase
    const result = computeKeyboardHeight({ isNativeEvent: false, nativeKbh: 0, webKbh: 290 });
    expect(result).toBe(290);
  });

  it("returns webKbh with no prior native event (no hysteresis on first event)", () => {
    // No prime — lastNativeKbh starts at 0 after beforeEach reset
    const result = computeKeyboardHeight({ isNativeEvent: false, nativeKbh: 0, webKbh: 50 });
    expect(result).toBe(50);
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
