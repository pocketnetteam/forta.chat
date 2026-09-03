import { describe, expect, it } from "vitest";
import { patchBuildGradle, versionCodeFromVersionString } from "./lib/android-version.mjs";
import { readPackageVersion } from "./lib/resolve-test-apk-version.mjs";

describe("readPackageVersion + patchBuildGradle (local cap:build injection)", () => {
  it("computes the same versionCode formula as the release CI sed step", () => {
    expect(versionCodeFromVersionString("1.11.1")).toBe(11_101);
  });

  it("patches a placeholder build.gradle with the resolved package.json version", () => {
    const placeholder = `
        versionCode 1
        versionName "1.0.0"
`;
    const version = readPackageVersion("package.json");
    const versionCode = versionCodeFromVersionString(version);

    const result = patchBuildGradle(placeholder, version, versionCode);

    expect(result).toContain(`versionCode ${versionCode}`);
    expect(result).toContain(`versionName "${version}"`);
  });
});
