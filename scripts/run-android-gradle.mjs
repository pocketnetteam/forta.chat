#!/usr/bin/env node
/**
 * Cross-platform Gradle wrapper for android/ (gradlew / gradlew.bat).
 * Usage: node scripts/run-android-gradle.mjs <task...>
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const androidDir = path.join(root, "android");
const tasks = process.argv.slice(2);

if (tasks.length === 0) {
  console.error("Usage: node scripts/run-android-gradle.mjs <gradle-task...>");
  process.exit(1);
}

const isWin = process.platform === "win32";
// ".\\" prefix required: this machine (and possibly others) has the
// NoDefaultCurrentDirectoryInExePath env var set, which stops cmd.exe from
// implicitly resolving a bare relative filename against cwd — it silently
// falls back to PATH-only lookup and fails with "'gradlew.bat' is not
// recognized". `.\gradlew.bat` bypasses PATH lookup entirely.
const cmd = isWin ? ".\\gradlew.bat" : "./gradlew";

const result = spawnSync(cmd, tasks, {
  cwd: androidDir,
  stdio: "inherit",
  shell: isWin,
  env: process.env,
});

process.exit(result.status ?? 1);
