import { describe, it, expect, vi, afterEach } from "vitest";
import { shouldShowBastyonWarning } from "../bastyon-warning";
import { interopLog } from "../interop-log";

describe("shouldShowBastyonWarning", () => {
  it("shows when on native Android, likely a Bastyon user, and not dismissed", () => {
    expect(
      shouldShowBastyonWarning({
        likelyBastyonUser: true,
        dismissed: false,
        isNativeAndroid: true,
      })
    ).toBe(true);
  });

  it("hides once dismissed", () => {
    expect(
      shouldShowBastyonWarning({
        likelyBastyonUser: true,
        dismissed: true,
        isNativeAndroid: true,
      })
    ).toBe(false);
  });

  it("hides when the account shows no Bastyon signal", () => {
    expect(
      shouldShowBastyonWarning({
        likelyBastyonUser: false,
        dismissed: false,
        isNativeAndroid: true,
      })
    ).toBe(false);
  });

  it("hides off native Android (web/electron — apps can't coexist)", () => {
    expect(
      shouldShowBastyonWarning({
        likelyBastyonUser: true,
        dismissed: false,
        isNativeAndroid: false,
      })
    ).toBe(false);
  });
});

describe("interopLog", () => {
  afterEach(() => vi.restoreAllMocks());

  it("emits a scoped [interop:<scope>] marker with data", () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    interopLog("push", "call push → ring", { callId: "abc" });
    expect(spy).toHaveBeenCalledWith("[interop:push]", "call push → ring", { callId: "abc" });
  });

  it("emits without a data argument when none is given", () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    interopLog("auth", "existing account detected");
    expect(spy).toHaveBeenCalledWith("[interop:auth]", "existing account detected");
  });
});
