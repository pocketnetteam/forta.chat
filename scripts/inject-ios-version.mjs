#!/usr/bin/env node
/**
 * Injects app version into ios/App/App.xcodeproj/project.pbxproj from package.json
 * (same scheme as Android: versionName + versionCode = major*10000+minor*100+patch).
 *
 * Usage:
 *   node scripts/inject-ios-version.mjs
 *   node scripts/inject-ios-version.mjs --version 1.11.0
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { versionCodeFromVersionString } from "./lib/android-version.mjs";
import { patchXcodeProject } from "./lib/ios-version.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pbxprojPath = path.join(root, "ios", "App", "App.xcodeproj", "project.pbxproj");
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

/**
 * @returns {string}
 */
function readPackageVersion() {
  const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  const version = typeof pkg.version === "string" ? pkg.version.trim() : "";
  if (!version) {
    throw new Error(`Missing "version" in ${packageJsonPath}`);
  }
  return version;
}

function main() {
  const { version: argVersion } = parseArgs(process.argv.slice(2));
  const version = argVersion || readPackageVersion();
  const versionCode = versionCodeFromVersionString(version);

  const content = readFileSync(pbxprojPath, "utf8");
  writeFileSync(pbxprojPath, patchXcodeProject(content, version, versionCode), "utf8");

  console.log(
    `[inject-ios-version] MARKETING_VERSION=${version} CURRENT_PROJECT_VERSION=${versionCode}`,
  );
}

main();
