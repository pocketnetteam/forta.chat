import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  MNEMONIC_STORAGE_KEY,
  saveMnemonic,
  loadMnemonic,
  clearMnemonic,
} from "../mnemonic-storage";

describe("mnemonic-storage", () => {
  beforeEach(() => {
    // Fresh sessionStorage for every test
    if (typeof sessionStorage !== "undefined") sessionStorage.clear();
  });

  it("saveMnemonic writes to sessionStorage under a stable key", () => {
    saveMnemonic("word1 word2 word3");
    expect(sessionStorage.getItem(MNEMONIC_STORAGE_KEY)).toBe("word1 word2 word3");
  });

  it("loadMnemonic reads back the saved mnemonic", () => {
    saveMnemonic("alpha beta gamma");
    expect(loadMnemonic()).toBe("alpha beta gamma");
  });

  it("loadMnemonic returns null when nothing is stored", () => {
    expect(loadMnemonic()).toBeNull();
  });

  it("clearMnemonic removes the saved mnemonic", () => {
    saveMnemonic("to be deleted");
    expect(loadMnemonic()).toBe("to be deleted");
    clearMnemonic();
    expect(loadMnemonic()).toBeNull();
    expect(sessionStorage.getItem(MNEMONIC_STORAGE_KEY)).toBeNull();
  });

  it("refuses to save empty or whitespace-only mnemonics (no-op)", () => {
    saveMnemonic("");
    expect(loadMnemonic()).toBeNull();
    saveMnemonic("    ");
    expect(loadMnemonic()).toBeNull();
  });

  it("tolerates sessionStorage throwing (quota, disabled, etc.)", () => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = vi.fn(() => {
      throw new Error("QuotaExceededError");
    });
    expect(() => saveMnemonic("safe call should not throw")).not.toThrow();
    Storage.prototype.setItem = original;
  });

  it("tolerates sessionStorage being unavailable on load", () => {
    const original = Storage.prototype.getItem;
    Storage.prototype.getItem = vi.fn(() => {
      throw new Error("SecurityError");
    });
    expect(loadMnemonic()).toBeNull();
    Storage.prototype.getItem = original;
  });
});
