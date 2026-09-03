#!/usr/bin/env node
/**
 * Injects app version into android/app/build.gradle from package.json
 * (same sed CI does for the release build — see android-release.yml).
 * Runs as part of `cap:build`, so local `cap:run` / `cap:apk` / `cap:aab:play`
 * carry the real app version instead of the placeholder "1.0.0" and don't
 * false-trigger AppUpdater's "update available" prompt.
 *
 * Usage:
 *   node scripts/inject-android-version.mjs
 *   node scripts/inject-android-version.mjs --version 1.11.0
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { patchBuildGradle, versionCodeFromVersionString } from "./lib/android-version.mjs";
import { readPackageVersion } from "./lib/resolve-test-apk-version.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const gradlePath = path.join(root, "android", "app", "build.gradle");
const packageJsonPath = path.join(root, "package.json");

/**
 * @param {string[]} argv
 * @returns {{ version: string }}
 */
function parseArgs(argv) {
  let version = "";
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--version" && argv[i + 1]) {
      version = argv[++i];
    }
  }
  return { version };
}

function main() {
  const { version: argVersion } = parseArgs(process.argv.slice(2));
  const version = argVersion || readPackageVersion(packageJsonPath);
  const versionCode = versionCodeFromVersionString(version);

  const content = readFileSync(gradlePath, "utf8");
  writeFileSync(gradlePath, patchBuildGradle(content, version, versionCode), "utf8");

  console.log(`[inject-android-version] versionName=${version} versionCode=${versionCode}`);
}

main();
