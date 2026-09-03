/**
 * Locate adb.exe (or adb on posix) the same way scripts/ensure-android-sdk.mjs
 * locates the SDK — ANDROID_HOME / ANDROID_SDK_ROOT / platform default —
 * so device scripts don't depend on adb being on PATH (it usually isn't on
 * Windows dev machines that only installed Android Studio).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function defaultSdkCandidates() {
  const home = os.homedir();
  switch (process.platform) {
    case "win32":
      return [
        process.env.ANDROID_HOME,
        process.env.ANDROID_SDK_ROOT,
        path.join(process.env.LOCALAPPDATA ?? "", "Android", "Sdk"),
      ];
    case "darwin":
      return [
        process.env.ANDROID_HOME,
        process.env.ANDROID_SDK_ROOT,
        path.join(home, "Library", "Android", "sdk"),
      ];
    default:
      return [
        process.env.ANDROID_HOME,
        process.env.ANDROID_SDK_ROOT,
        path.join(home, "Android", "Sdk"),
      ];
  }
}

/** @returns {string} absolute path to the adb binary. Throws if not found. */
export function findAdb() {
  const adbName = process.platform === "win32" ? "adb.exe" : "adb";
  for (const candidate of defaultSdkCandidates()) {
    if (!candidate) continue;
    const adbPath = path.join(path.resolve(candidate), "platform-tools", adbName);
    if (fs.existsSync(adbPath)) return adbPath;
  }
  throw new Error(
    "[adb] Not found under ANDROID_HOME/ANDROID_SDK_ROOT/default SDK location. Install platform-tools.",
  );
}
