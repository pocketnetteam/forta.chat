import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  normalizeTorSettings,
  parseTorSettingsJson,
  serializeTorSettings,
} = require("../../../../electron/tor/settings-persist.cjs");

describe("electron tor settings-persist", () => {
  it("parses valid persisted settings", () => {
    expect(
      parseTorSettingsJson(
        JSON.stringify({ enabled3: "always", useSnowFlake2: true }),
      ),
    ).toEqual({ enabled3: "always", useSnowFlake2: true });
  });

  it("rejects invalid mode", () => {
    expect(normalizeTorSettings({ enabled3: "bogus", useSnowFlake2: true })).toBeNull();
  });

  it("returns null for corrupt JSON", () => {
    expect(parseTorSettingsJson("{not-json")).toBeNull();
  });

  it("serializes with neveruse fallback for bad mode", () => {
    const text = serializeTorSettings({ enabled3: "nope", useSnowFlake2: 1 });
    expect(JSON.parse(text)).toEqual({
      enabled3: "neveruse",
      useSnowFlake2: true,
    });
  });

  it("round-trips always + snowflake", () => {
    const text = serializeTorSettings({
      enabled3: "always",
      useSnowFlake2: true,
    });
    expect(parseTorSettingsJson(text)).toEqual({
      enabled3: "always",
      useSnowFlake2: true,
    });
  });
});
