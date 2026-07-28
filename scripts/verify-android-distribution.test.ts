import { describe, expect, it } from "vitest";
import {
  assertApkUpdateFilePath,
  assertEnableAppUpdater,
  assertInstallPermission,
  pickPathMatching,
} from "./lib/verify-android-distribution.mjs";

describe("verify-android-distribution helpers", () => {
  it("requires REQUEST_INSTALL_PACKAGES on sideload", () => {
    const withPerm = `<uses-permission android:name="android.permission.REQUEST_INSTALL_PACKAGES" />`;
    expect(assertInstallPermission(withPerm, true).ok).toBe(true);
    expect(assertInstallPermission("<manifest/>", true).ok).toBe(false);
  });

  it("forbids REQUEST_INSTALL_PACKAGES on play", () => {
    const withPerm = `<uses-permission android:name="android.permission.REQUEST_INSTALL_PACKAGES" />`;
    expect(assertInstallPermission("<manifest/>", false).ok).toBe(true);
    expect(assertInstallPermission(withPerm, false).ok).toBe(false);
  });

  it("checks ENABLE_APP_UPDATER BuildConfig field", () => {
    expect(
      assertEnableAppUpdater(
        "public static final boolean ENABLE_APP_UPDATER = true;",
        true,
      ).ok,
    ).toBe(true);
    expect(
      assertEnableAppUpdater(
        "public static final boolean ENABLE_APP_UPDATER = false;",
        false,
      ).ok,
    ).toBe(true);
    expect(
      assertEnableAppUpdater(
        "public static final boolean ENABLE_APP_UPDATER = true;",
        false,
      ).ok,
    ).toBe(false);
  });

  it("checks apk_updates file path for sideload installs", () => {
    const xml = `
      <paths>
        <external-files-path name="apk_updates" path="updates/" />
      </paths>
    `;
    expect(assertApkUpdateFilePath(xml).ok).toBe(true);
    expect(assertApkUpdateFilePath("<paths/>").ok).toBe(false);
  });

  it("picks flavor-specific intermediate paths", () => {
    const paths = [
      "a/merged_manifests/sideloadRelease/AndroidManifest.xml",
      "a/merged_manifests/playRelease/AndroidManifest.xml",
    ];
    expect(
      pickPathMatching(paths, /merged_manifests\/sideloadRelease\//),
    ).toContain("sideloadRelease");
    expect(
      pickPathMatching(paths, /merged_manifests\/playRelease\//),
    ).toContain("playRelease");
  });
});
