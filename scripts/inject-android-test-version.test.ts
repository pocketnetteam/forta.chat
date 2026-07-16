import { describe, expect, it } from "vitest";
import {
  bumpPatch,
  compareSemverStrings,
  formatSemver,
  maxSemverString,
  parseSemver,
  patchBuildGradle,
  resolveNextAndroidVersion,
  versionCodeFromSemver,
  versionCodeFromVersionString,
} from "./lib/android-version.mjs";
import {
  fetchLatestDeployedTestVersion,
  readPackageVersion,
  resolveNextTestApkVersion,
  resolveNextTestApkVersionFromSources,
} from "./lib/resolve-test-apk-version.mjs";

describe("parseSemver", () => {
  it("parses valid semver", () => {
    expect(parseSemver("1.10.45")).toEqual({ major: 1, minor: 10, patch: 45 });
  });

  it("rejects invalid semver", () => {
    expect(parseSemver("1.10")).toBeNull();
    expect(parseSemver("test-d112f80")).toBeNull();
  });
});

describe("versionCodeFromSemver", () => {
  it("matches production CI formula", () => {
    expect(versionCodeFromSemver({ major: 1, minor: 10, patch: 45 })).toBe(11_045);
    expect(versionCodeFromVersionString("1.2.3")).toBe(10_203);
  });
});

describe("resolveNextAndroidVersion", () => {
  it("bumps patch by 1 from package.json version", () => {
    expect(resolveNextAndroidVersion(["1.10.45"])).toEqual({
      versionName: "1.10.46",
      versionCode: 11_046,
    });
  });

  it("uses max of package.json and deployed test version before bumping", () => {
    expect(resolveNextAndroidVersion(["1.10.45", "1.10.46"])).toEqual({
      versionName: "1.10.47",
      versionCode: 11_047,
    });
  });
});

describe("compareSemverStrings / maxSemverString", () => {
  it("compares semver parts", () => {
    expect(compareSemverStrings("1.10.46", "1.10.45")).toBeGreaterThan(0);
    expect(maxSemverString(["1.10.45", "1.10.46", "1.9.99"])).toBe("1.10.46");
  });
});

describe("bumpPatch", () => {
  it("increments only patch", () => {
    expect(formatSemver(bumpPatch({ major: 1, minor: 10, patch: 45 }))).toBe("1.10.46");
  });
});

describe("patchBuildGradle", () => {
  const sample = `
        versionCode 1
        versionName "1.0.0"
`;

  it("replaces versionCode and versionName", () => {
    const result = patchBuildGradle(sample, "1.10.46", 11_046);
    expect(result).toContain("versionCode 11046");
    expect(result).toContain('versionName "1.10.46"');
  });
});

describe("readPackageVersion", () => {
  it("reads version field from package.json", () => {
    expect(readPackageVersion("package.json")).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe("resolveNextTestApkVersion", () => {
  it("requires at least package.json version", () => {
    expect(() => resolveNextTestApkVersion([])).toThrow(/package.json/);
  });
});

describe("fetchLatestDeployedTestVersion", () => {
  it("reads versionName from apktests/version.json", async () => {
    const fetchImpl = async () =>
      ({
        ok: true,
        json: async () => ({ versionName: "1.10.46", versionCode: 11_046 }),
      }) as Response;

    await expect(fetchLatestDeployedTestVersion(fetchImpl)).resolves.toBe("1.10.46");
  });
});

describe("resolveNextTestApkVersionFromSources", () => {
  it("bumps from package.json when no deployed test version exists", async () => {
    const fetchImpl = async () => ({ ok: false }) as Response;

    const result = await resolveNextTestApkVersionFromSources({
      packageJsonPath: "package.json",
      fetchImpl,
    });

    expect(result.versionName).toMatch(/^\d+\.\d+\.\d+$/);
    expect(result.versionCode).toBeGreaterThan(0);
  });
});
