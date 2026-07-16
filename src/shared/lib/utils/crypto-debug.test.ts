import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  cryptoDebug,
  isCryptoDebugEnabled,
  looksLikeMention,
  resetCryptoDebugCache,
} from "./crypto-debug";

describe("crypto-debug helpers (WEE-39)", () => {
  beforeEach(() => {
    localStorage.clear();
    resetCryptoDebugCache();
  });

  afterEach(() => {
    localStorage.clear();
    resetCryptoDebugCache();
    vi.restoreAllMocks();
  });

  describe("isCryptoDebugEnabled", () => {
    it("returns false by default (no flag set)", () => {
      expect(isCryptoDebugEnabled()).toBe(false);
    });

    it("returns true when localStorage flag is exactly '1'", () => {
      localStorage.setItem("debug:crypto", "1");
      resetCryptoDebugCache();
      expect(isCryptoDebugEnabled()).toBe(true);
    });

    it("returns false for any other localStorage value", () => {
      localStorage.setItem("debug:crypto", "true");
      resetCryptoDebugCache();
      expect(isCryptoDebugEnabled()).toBe(false);
    });

    it("caches result — DevTools toggle requires resetCryptoDebugCache()", () => {
      expect(isCryptoDebugEnabled()).toBe(false);
      localStorage.setItem("debug:crypto", "1");
      // Without explicit reset the cached `false` survives.
      expect(isCryptoDebugEnabled()).toBe(false);
      resetCryptoDebugCache();
      expect(isCryptoDebugEnabled()).toBe(true);
    });
  });

  describe("cryptoDebug", () => {
    it("is a no-op when flag is off (does not call console.warn)", () => {
      const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
      cryptoDebug("encrypt", { tetatet: true });
      expect(spy).not.toHaveBeenCalled();
    });

    it("logs structural payload when flag is on", () => {
      localStorage.setItem("debug:crypto", "1");
      resetCryptoDebugCache();
      const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
      cryptoDebug("encrypt", { tetatet: false, textLen: 42 });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][0]).toBe("[crypto-debug:encrypt]");
      expect(spy.mock.calls[0][1]).toEqual({ tetatet: false, textLen: 42 });
    });
  });

  describe("looksLikeMention", () => {
    it("detects leading @mention", () => {
      expect(looksLikeMention("@AlexD hi")).toBe(true);
    });

    it("detects mid-string @mention with whitespace prefix", () => {
      expect(looksLikeMention("Привет @AlexD как дела?")).toBe(true);
    });

    it("ignores @ inside emails (no whitespace boundary in front)", () => {
      expect(looksLikeMention("send to user@example.com")).toBe(false);
    });

    it("returns false for plain text without @", () => {
      expect(looksLikeMention("Hello world")).toBe(false);
    });

    it("returns false for empty / single-char input", () => {
      expect(looksLikeMention("")).toBe(false);
      expect(looksLikeMention("@")).toBe(false);
    });
  });
});
