import { describe, expect, it } from "vitest";
import {
  computeTestVersionCode,
  computeTestVersionName,
  patchBuildGradle,
} from "./lib/android-test-version.mjs";

describe("computeTestVersionName", () => {
  it("prefixes short sha with test-", () => {
    expect(computeTestVersionName("a1b2c3d")).toBe("test-a1b2c3d");
  });

  it("truncates long sha to 7 hex chars", () => {
    expect(computeTestVersionName("a1b2c3d4e5f6")).toBe("test-a1b2c3d");
  });

  it("lowercases sha", () => {
    expect(computeTestVersionName("A1B2C3D")).toBe("test-a1b2c3d");
  });

  it("rejects non-hex sha", () => {
    expect(() => computeTestVersionName("notahex")).toThrow(/Invalid git sha/);
  });
});

describe("computeTestVersionCode", () => {
  it("offsets run number by 900000", () => {
    expect(computeTestVersionCode(1)).toBe(900_001);
    expect(computeTestVersionCode(42)).toBe(900_042);
  });

  it("rejects invalid run numbers", () => {
    expect(() => computeTestVersionCode(0)).toThrow(/Invalid run number/);
    expect(() => computeTestVersionCode("x")).toThrow(/Invalid run number/);
  });
});

describe("patchBuildGradle", () => {
  const sample = `
        versionCode 1
        versionName "1.0.0"
`;

  it("replaces versionCode and versionName", () => {
    const result = patchBuildGradle(sample, "test-deadbeef", 900_123);
    expect(result).toContain("versionCode 900123");
    expect(result).toContain('versionName "test-deadbeef"');
  });

  it("throws when nothing changes", () => {
    expect(() => patchBuildGradle("no version fields", "test-abc", 900_001)).toThrow(
      /not updated/,
    );
  });
});
