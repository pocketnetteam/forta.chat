#!/usr/bin/env node
/**
 * Injects CI test-build version into android/app/build.gradle.
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  computeTestVersionCode,
  computeTestVersionName,
  patchBuildGradle,
} from "./lib/android-test-version.mjs";

function parseArgs(argv) {
  let sha = "";
  let runNumber = "";

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--sha" && argv[i + 1]) {
      sha = argv[++i];
    } else if (argv[i] === "--run-number" && argv[i + 1]) {
      runNumber = argv[++i];
    }
  }

  if (!sha || !runNumber) {
    throw new Error("Usage: node inject-android-test-version.mjs --sha <sha> --run-number <n>");
  }

  return { sha, runNumber };
}

function main() {
  const { sha, runNumber } = parseArgs(process.argv.slice(2));
  const versionName = computeTestVersionName(sha);
  const versionCode = computeTestVersionCode(runNumber);

  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const gradlePath = path.join(root, "android", "app", "build.gradle");
  const content = readFileSync(gradlePath, "utf8");
  writeFileSync(gradlePath, patchBuildGradle(content, versionName, versionCode), "utf8");

  console.log(`[inject-android-test-version] versionName=${versionName} versionCode=${versionCode}`);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  main();
}
