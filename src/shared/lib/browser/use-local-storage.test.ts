import { describe, it, expect, vi, afterEach } from "vitest";
import { APP_NAME } from "@/shared/config";
import { useLocalStorage } from "./use-local-storage";

/** Audit W2A-02: storage errors threw out of the stores and theme setters. */
describe("useLocalStorage", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
  });

  it("round-trips a value under the app prefix", () => {
    const { setLSValue } = useLocalStorage("theme", "light");
    setLSValue("dark");
    expect(window.localStorage.getItem(`${APP_NAME}:theme`)).toBe('"dark"');
    expect(useLocalStorage("theme", "light").value).toBe("dark");
  });

  it("falls back to the initial value when the stored value is not JSON", () => {
    window.localStorage.setItem(`${APP_NAME}:theme`, "{not json");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(useLocalStorage("theme", "light").value).toBe("light");
  });

  it("falls back to the initial value when storage cannot be read", () => {
    vi.spyOn(window.localStorage, "getItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(useLocalStorage("fontSize", 16).value).toBe(16);
    expect(warn).toHaveBeenCalled();
  });

  it("does not throw when a write fails (quota, blocked storage)", () => {
    vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { setLSValue } = useLocalStorage("accent", "blue");
    expect(() => setLSValue("red")).not.toThrow();
    expect(warn).toHaveBeenCalled();
  });
});
