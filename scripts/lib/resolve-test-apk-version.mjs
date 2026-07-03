/**
 * Resolves the next test APK version from package.json and apktests/version.json.
 */

import { readFileSync } from "node:fs";
import { resolveNextAndroidVersion } from "./android-version.mjs";

export const TEST_VERSION_URL = "https://forta.chat/apktests/version.json";

/**
 * @param {string} packageJsonPath
 * @returns {string}
 */
export function readPackageVersion(packageJsonPath) {
  const raw = readFileSync(packageJsonPath, "utf8");
  const pkg = JSON.parse(raw);
  const version = typeof pkg.version === "string" ? pkg.version.trim() : "";

  if (!version) {
    throw new Error(`Missing "version" in ${packageJsonPath}`);
  }

  return version;
}

/**
 * @param {() => Promise<Response>} fetchImpl
 * @returns {Promise<string | null>}
 */
export async function fetchLatestDeployedTestVersion(fetchImpl = fetch) {
  try {
    const response = await fetchImpl(TEST_VERSION_URL, { cache: "no-store" });
    if (!response.ok) {
      return null;
    }

    const data = await response.json();
    return typeof data.versionName === "string" ? data.versionName : null;
  } catch {
    return null;
  }
}

/**
 * @param {string[]} versions
 * @returns {{ versionName: string; versionCode: number }}
 */
export function resolveNextTestApkVersion(versions) {
  const baseVersions = versions.filter(Boolean);
  if (baseVersions.length === 0) {
    throw new Error("Cannot resolve next version: package.json version is required");
  }

  return resolveNextAndroidVersion(baseVersions);
}

/**
 * @param {object} options
 * @param {string} options.packageJsonPath
 * @param {() => Promise<Response>} [options.fetchImpl]
 * @returns {Promise<{ versionName: string; versionCode: number }>}
 */
export async function resolveNextTestApkVersionFromSources({
  packageJsonPath,
  fetchImpl = fetch,
}) {
  const packageVersion = readPackageVersion(packageJsonPath);
  const deployedTestVersion = await fetchLatestDeployedTestVersion(fetchImpl);

  return resolveNextTestApkVersion([packageVersion, deployedTestVersion]);
}
