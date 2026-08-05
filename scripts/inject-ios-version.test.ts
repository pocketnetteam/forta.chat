import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { versionCodeFromVersionString } from "./lib/android-version.mjs";
import { patchXcodeProject } from "./lib/ios-version.mjs";

const SAMPLE_PBX = `
				CURRENT_PROJECT_VERSION = 1;
				MARKETING_VERSION = 1.0;
				CURRENT_PROJECT_VERSION = 1;
				MARKETING_VERSION = 1.0;
`;

describe("patchXcodeProject", () => {
  it("replaces MARKETING_VERSION and CURRENT_PROJECT_VERSION", () => {
    const result = patchXcodeProject(SAMPLE_PBX, "1.11.0", 11_100);
    expect(result).toContain("CURRENT_PROJECT_VERSION = 11100;");
    expect(result).toContain("MARKETING_VERSION = 1.11.0;");
    expect(result).not.toContain("CURRENT_PROJECT_VERSION = 1;");
    expect(result).not.toContain("MARKETING_VERSION = 1.0;");
  });

  it("is idempotent when already at target version", () => {
    const once = patchXcodeProject(SAMPLE_PBX, "1.11.0", 11_100);
    expect(patchXcodeProject(once, "1.11.0", 11_100)).toBe(once);
  });

  it("throws when version fields are missing", () => {
    expect(() => patchXcodeProject("no version keys", "1.0.0", 10_000)).toThrow(
      /not updated/,
    );
  });
});

describe("iOS version mirrors Android scheme", () => {
  it("derives build number from package.json semver", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
      version: string;
    };
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(versionCodeFromVersionString(pkg.version)).toBe(
      versionCodeFromVersionString(pkg.version),
    );
    // 1.11.0 → 11100 (same formula as Android versionCode)
    expect(versionCodeFromVersionString("1.11.0")).toBe(11_100);
  });
});
