import { describe, it, expect } from "vitest";
import {
  TOR_MODE_CYCLE,
  fromNativeBridgeType,
  getNextTorMode,
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
});
