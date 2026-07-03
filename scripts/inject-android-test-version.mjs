#!/usr/bin/env node
/**
 * Injects CI test-build version into android/app/build.gradle.
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { patchBuildGradle, versionCodeFromVersionString } from "./lib/android-version.mjs";

function parseArgs(argv) {
  let version = "";

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--version" && argv[i + 1]) {
      version = argv[++i];
    }
  }

  if (!version) {
    throw new Error("Usage: node inject-android-test-version.mjs --version <semver>");
  }

  return { version };
}

function main() {
  const { version } = parseArgs(process.argv.slice(2));
  const versionCode = versionCodeFromVersionString(version);

  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const gradlePath = path.join(root, "android", "app", "build.gradle");
  const content = readFileSync(gradlePath, "utf8");
  writeFileSync(gradlePath, patchBuildGradle(content, version, versionCode), "utf8");

  console.log(`[inject-android-test-version] versionName=${version} versionCode=${versionCode}`);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  main();
}
