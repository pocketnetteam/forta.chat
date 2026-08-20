#!/usr/bin/env node
/**
 * Windows-safe replacement for `npx cap run android`.
 *
 * `@capacitor/cli`'s own `run` command spawns the bare `gradlew` binary
 * without the `.bat` extension / a shell, which fails on Windows with
 * "'gradlew' is not recognized..." (cap:apk/cap:aab:play already work
 * around this the same way via run-android-gradle.mjs — this does the same
 * for the day-to-day "install + launch on a connected device" loop).
 *
 * Also doubles as the AI-integration smoke test asked for in
 * docs/plans/llama2/device-ai-loop.md: after launch it dumps a short
 * logcat window and flags anything that looks like a crash or a local-ai
 * error, since there is no automated on-device test for that yet.
 *
 * Usage: node scripts/run-android-device.mjs [--no-smoke]
 * Assumes `npm run cap:build` already ran (dist synced into android/).
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findAdb } from "./find-adb.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const androidDir = path.join(root, "android");
const APP_ID = "com.forta.chat";
const LAUNCHER = `${APP_ID}/.MainActivity`;
const SMOKE_WINDOW_MS = 12_000;

const runSmoke = !process.argv.includes("--no-smoke");

function runGradle(task) {
  const isWin = process.platform === "win32";
  // See scripts/run-android-gradle.mjs for why the ".\\" prefix matters
  // (NoDefaultCurrentDirectoryInExePath breaks bare "gradlew.bat" lookup).
  const cmd = isWin ? ".\\gradlew.bat" : "./gradlew";
  console.log(`[run-android-device] gradle ${task}`);
  const result = spawnSync(cmd, [task], { cwd: androidDir, stdio: "inherit", shell: isWin });
  if (result.status !== 0) {
    console.error(`[run-android-device] gradle task '${task}' failed (exit ${result.status})`);
    process.exit(result.status ?? 1);
  }
}

function adb(args, opts = {}) {
  const adbPath = findAdb();
  return spawnSync(adbPath, args, { encoding: "utf8", ...opts });
}

function requireDevice() {
  const result = adb(["devices"]);
  const lines = result.stdout
    .split(/\r?\n/)
    .slice(1)
    .filter((l) => l.trim() && l.includes("\tdevice"));
  if (lines.length === 0) {
    console.error(
      "[run-android-device] No authorized device/emulator in `adb devices`. Connect one (USB debugging on) and retry.",
    );
    process.exit(1);
  }
  console.log(`[run-android-device] Target device(s): ${lines.map((l) => l.split("\t")[0]).join(", ")}`);
}

// AI-integration signal set. Not exhaustive — extend as new local-ai
// failure modes are found (see docs/plans/llama2/device-ai-loop.md).
const CRASH_PATTERNS = [/FATAL EXCEPTION/i, /AndroidRuntime:\s*FATAL/i, /Process:\s*com\.forta\.chat.*has died/i];
const AI_SIGNAL_PATTERNS = [
  /local-ai/i,
  /local_ai/i,
  /llama[-_]?cpp/i,
  /LlamaCpp/i,
  /LocalAi/i,
  /CreateConnection/i,
  /Already in transaction/i,
  /capgo.*download/i,
  /Capacitor\/Console.*(error|Error|Uncaught)/,
];

function runSmokeCapture() {
  console.log("[run-android-device] Clearing logcat and launching app...");
  adb(["logcat", "-c"]);
  const start = adb(["shell", "am", "start", "-n", LAUNCHER]);
  if (start.status !== 0) {
    console.error("[run-android-device] `adb shell am start` failed:", start.stderr || start.stdout);
    process.exit(1);
  }
  console.log(`[run-android-device] Launched ${LAUNCHER}. Capturing logcat for ${SMOKE_WINDOW_MS / 1000}s`);
  console.log("[run-android-device] Exercise the AI tab on the device now (see qa-checklist-phase7.md) if this is a manual pass.");

  const waitUntil = Date.now() + SMOKE_WINDOW_MS;
  while (Date.now() < waitUntil) {
    // busy-wait in short slices; spawnSync has no async sleep without extra deps
    spawnSync(process.platform === "win32" ? "cmd" : "sleep", process.platform === "win32" ? ["/c", "timeout /t 1 >nul"] : ["1"]);
  }

  const dump = adb(["logcat", "-d", "-v", "time"]);
  const logLines = (dump.stdout || "").split(/\r?\n/);

  const outDir = path.join(root, "logs");
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `android-smoke-${Date.now()}.log`);
  fs.writeFileSync(outFile, logLines.join("\n"));

  const crashes = logLines.filter((l) => CRASH_PATTERNS.some((p) => p.test(l)));
  const aiLines = logLines.filter((l) => AI_SIGNAL_PATTERNS.some((p) => p.test(l)));

  console.log(`\n[run-android-device] Full log: ${outFile}`);
  if (aiLines.length > 0) {
    console.log(`\n[run-android-device] ${aiLines.length} local-ai/llama-related line(s):`);
    for (const l of aiLines.slice(-40)) console.log("  " + l);
  } else {
    console.log("[run-android-device] No local-ai/llama-related log lines seen in the capture window.");
  }

  if (crashes.length > 0) {
    console.error(`\n[run-android-device] ${crashes.length} crash signal(s) found:`);
    for (const l of crashes) console.error("  " + l);
    console.error("\n[run-android-device] SMOKE: FAIL (crash detected)");
    process.exit(1);
  }
  console.log("\n[run-android-device] SMOKE: PASS (launched, no crash signal in capture window — this is not a full functional pass, see qa-checklist-phase7.md for the manual AI-flow checklist)");
}

requireDevice();
runGradle("installSideloadDebug");
if (runSmoke) {
  runSmokeCapture();
} else {
  adb(["shell", "am", "start", "-n", LAUNCHER]);
  console.log(`[run-android-device] Launched ${LAUNCHER} (--no-smoke, no logcat capture).`);
}
