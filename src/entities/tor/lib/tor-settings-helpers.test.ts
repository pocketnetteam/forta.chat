import { describe, it, expect } from "vitest";
import {
  TOR_MODE_CYCLE,
  fromNativeBridgeType,
  getNextTorMode,
  resolveBridgeOnEnable,
  shouldAutoEnableSnowflake,
  toNativeBridgeType,
} from "./tor-settings-helpers";

describe("tor-settings-helpers", () => {
  it("cycles modes neveruse → auto → always → neveruse", () => {
    expect(getNextTorMode("neveruse")).toBe("auto");
    expect(getNextTorMode("auto")).toBe("always");
    expect(getNextTorMode("always")).toBe("neveruse");
  });

  it("exports a stable mode cycle order", () => {
    expect([...TOR_MODE_CYCLE]).toEqual(["neveruse", "auto", "always"]);
  });

  it("maps native bridge types", () => {
    expect(fromNativeBridgeType("SNOWFLAKE")).toBe("snowflake");
    expect(fromNativeBridgeType("snowflake")).toBe("snowflake");
    expect(fromNativeBridgeType("NONE")).toBe("none");
    expect(fromNativeBridgeType("OBFS4")).toBe("none");
  });

  it("maps bridge types to native", () => {
    expect(toNativeBridgeType("snowflake")).toBe("SNOWFLAKE");
    expect(toNativeBridgeType("none")).toBe("NONE");
  });

  describe("shouldAutoEnableSnowflake", () => {
    it("enables for ru app locale", () => {
      expect(shouldAutoEnableSnowflake("ru", "en-US")).toBe(true);
    });

    it("enables for fa app locale", () => {
      expect(shouldAutoEnableSnowflake("fa", "en-US")).toBe(true);
    });

    it("enables for browser fa-IR even when app locale is en", () => {
      expect(shouldAutoEnableSnowflake("en", "fa-IR")).toBe(true);
    });

    it("enables for browser ru-RU", () => {
      expect(shouldAutoEnableSnowflake("en", "ru-RU")).toBe(true);
    });

    it("stays off for en / en-US", () => {
      expect(shouldAutoEnableSnowflake("en", "en-US")).toBe(false);
    });
  });

  describe("resolveBridgeOnEnable", () => {
    it("auto-picks snowflake when enabling Tor in ru locale with none bridge", () => {
      expect(
        resolveBridgeOnEnable("neveruse", "always", "none", "ru", "en-US"),
      ).toBe("snowflake");
    });

    it("keeps existing snowflake bridge", () => {
      expect(
        resolveBridgeOnEnable("neveruse", "auto", "snowflake", "en", "en-US"),
      ).toBe("snowflake");
    });

    it("does not change bridge when disabling Tor", () => {
      expect(
        resolveBridgeOnEnable("always", "neveruse", "none", "ru", "ru-RU"),
      ).toBe("none");
    });

    it("does not change bridge when already enabled", () => {
      expect(
        resolveBridgeOnEnable("auto", "always", "none", "ru", "ru-RU"),
      ).toBe("none");
    });

    it("leaves none for en locale without fa/ru browser lang", () => {
      expect(
        resolveBridgeOnEnable("neveruse", "always", "none", "en", "en-US"),
      ).toBe("none");
    });
  });
});
