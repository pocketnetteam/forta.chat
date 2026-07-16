import { describe, it, expect } from "vitest";
import { shouldSendOnEnter, type EnterKeyContext } from "./enter-key-behavior";

function ctx(overrides: Partial<EnterKeyContext> = {}): EnterKeyContext {
  return {
    key: "Enter",
    shiftKey: false,
    isComposing: false,
    isMobile: false,
    isNative: false,
    ...overrides,
  };
}

describe("shouldSendOnEnter", () => {
  describe("desktop (non-mobile, non-native)", () => {
    it("sends on Enter", () => {
      expect(shouldSendOnEnter(ctx())).toBe(true);
    });

    it("does not send on Shift+Enter (newline)", () => {
      expect(shouldSendOnEnter(ctx({ shiftKey: true }))).toBe(false);
    });

    it("ignores non-Enter keys", () => {
      expect(shouldSendOnEnter(ctx({ key: "a" }))).toBe(false);
      expect(shouldSendOnEnter(ctx({ key: "Escape" }))).toBe(false);
      expect(shouldSendOnEnter(ctx({ key: "Tab" }))).toBe(false);
    });

    it("does not send during IME composition", () => {
      expect(shouldSendOnEnter(ctx({ isComposing: true }))).toBe(false);
    });
  });

  describe("mobile web (isMobile = true)", () => {
    it("does not send on Enter — newline instead", () => {
      expect(shouldSendOnEnter(ctx({ isMobile: true }))).toBe(false);
    });

    it("does not send on Shift+Enter either", () => {
      expect(shouldSendOnEnter(ctx({ isMobile: true, shiftKey: true }))).toBe(false);
    });

    it("does not send during IME composition", () => {
      expect(shouldSendOnEnter(ctx({ isMobile: true, isComposing: true }))).toBe(false);
    });
  });

  describe("native Capacitor (Android/iOS)", () => {
    it("does not send on Enter — requires send button", () => {
      expect(shouldSendOnEnter(ctx({ isNative: true }))).toBe(false);
    });

    it("does not send even with isMobile=false (tablet landscape)", () => {
      expect(shouldSendOnEnter(ctx({ isNative: true, isMobile: false }))).toBe(false);
    });

    it("does not send during IME composition", () => {
      expect(shouldSendOnEnter(ctx({ isNative: true, isComposing: true }))).toBe(false);
    });
  });

  describe("edge cases", () => {
    it("composition + desktop = no send (CJK confirm)", () => {
      expect(shouldSendOnEnter(ctx({ isComposing: true }))).toBe(false);
    });

    it("composition + mobile + native = no send", () => {
      expect(shouldSendOnEnter(ctx({ isComposing: true, isMobile: true, isNative: true }))).toBe(false);
    });
  });
});
