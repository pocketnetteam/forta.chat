#!/usr/bin/env node
/**
 * Device-e2e smoke test for the AI model download flow, including a real
 * kill-mid-download / relaunch resume check — this used to be the manual
 * adb-tap-and-screenshot loop done by hand for
 * docs/plans/llama2/qa-checklist-phase7.md's "Свернуть приложение во время
 * активной загрузки" item and this session's resume verification.
 * Manual/emulator-only (real Capacitor bridge, real device) — never add
 * this to `npm test`, matches local-ai's own CLAUDE.md testing rule.
 *
 * Usage: node scripts/device-e2e/ai-download-resume.mjs [--kill-after-bytes=N]
 * Requires: a connected & authorized device, forta.chat already installed
 * (`npm run cap:run`), and a real reachable AI manifest (see
 * docs/plans/llama2/decisions.md — the placeholder manifestUrl won't work).
 *
 * Finds UI elements by their on-screen text via `uiautomator dump`
 * (ui-automator.mjs) instead of hardcoded pixel coordinates — those broke
 * repeatedly during manual testing whenever error text shifted the layout.
 *
 * Does NOT clear app data or the local-ai SQLite state — if a previous run
 * exhausted DownloadEngine's maxAttempts (5, and every app-kill-during-
 * download counts as one — a real gap logged in local-ai's decisions.md),
 * this will report that clearly rather than silently loop forever; clear
 * `databases/local_ai_*SQLite.db*` and `files/models/*.gguf` via
 * `adb shell run-as com.forta.chat` first if that happens.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { findAdb } from "../find-adb.mjs";
import { adb, sleep, dumpUiTree, findElement, tap, swipe, waitForElement, tapText } from "./ui-automator.mjs";

const APP_ID = "com.forta.chat";
const LAUNCHER = `${APP_ID}/.MainActivity`;
const killAfterBytesArg = process.argv.find((a) => a.startsWith("--kill-after-bytes="));
const KILL_AFTER_BYTES = killAfterBytesArg ? Number(killAfterBytesArg.split("=")[1]) : 15_000_000;
const POLL_TIMEOUT_MS = 5 * 60_000;

const adbPath = findAdb();
const outDir = path.join(process.cwd(), "logs", "device-e2e", `ai-download-resume-${Date.now()}`);
fs.mkdirSync(outDir, { recursive: true });

function screenshot(name) {
  // adb() (ui-automator.mjs) decodes stdout as utf8 for text commands —
  // screenshots need raw bytes, so this spawns directly instead.
  const result = spawnSync(adbPath, ["exec-out", "screencap", "-p"]);
  fs.writeFileSync(path.join(outDir, `${name}.png`), result.stdout);
}

function log(...args) {
  const line = args.join(" ");
  console.log(line);
  fs.appendFileSync(path.join(outDir, "run.log"), line + "\n");
}

function partialFileBytes() {
  const result = adb(["shell", "run-as", APP_ID, "sh", "-c", "stat -c %s files/models/*.gguf 2>/dev/null | tail -1"]);
  const n = Number((result.stdout || "").trim());
  return Number.isFinite(n) ? n : 0;
}

/**
 * Waits for the chat list to render, tolerating the WebView-renderer-sandbox
 * OOM-kill-then-backoff cycle found 2026-08-19 (`ActivityManager: Killing
 * ...sandboxed_process0` followed by repeated "process is bad" — Android
 * refusing to relaunch Chromium's renderer for a stretch, leaving the
 * Activity's native shell blank/white while it retries every ~3s). Matches
 * a white-screen-on-launch the user had already seen intermittently and
 * couldn't explain — likely worsened by exactly this kind of rapid
 * force-stop/relaunch cycling. One retry (force-stop + relonger wait) before
 * giving up, since the first wait alone wasn't enough to rule it out as
 * transient.
 */
async function waitForBoot() {
  let chatList = await waitForElement((t) => t === "Чаты" || t === "Поиск", { timeoutMs: 30000 });
  if (chatList) return;
  log("  boot wait timed out (possible WebView renderer-sandbox stall) — retrying once with a longer wait...");
  adb(["shell", "am", "force-stop", APP_ID]);
  await sleep(3000);
  adb(["shell", "am", "start", "-n", LAUNCHER]);
  chatList = await waitForElement((t) => t === "Чаты" || t === "Поиск", { timeoutMs: 60000 });
  if (!chatList) throw new Error("chat list never appeared after launch (even after a retry)");
}

async function navigateToAiChat() {
  await waitForBoot();
  swipe(960, 466, 240, 466, 400);
  await sleep(800);
  await tapText("AI", { timeoutMs: 8000 });
  await sleep(500);

  const xml = dumpUiTree();
  const existingChat = findElement(xml, (t) => t === "New chat");
  const newChatFab = findElement(xml, (t) => t === "Новый AI-чат");
  const target = existingChat ?? newChatFab;
  if (!target) throw new Error("neither an existing AI chat nor the 'Новый AI-чат' button was found");
  tap(target.center.x, target.center.y);
  await sleep(1500);
}

async function main() {
  const devices = adb(["devices"]).stdout;
  if (!/\tdevice\b/.test(devices)) {
    console.error("[ai-download-resume] No authorized device in `adb devices`.");
    process.exit(1);
  }

  adb(["logcat", "-c"]);
  adb(["shell", "am", "force-stop", APP_ID]);
  adb(["shell", "input", "keyevent", "KEYCODE_WAKEUP"]);
  adb(["shell", "am", "start", "-n", LAUNCHER]);
  log(`[ai-download-resume] Artifacts: ${outDir}`);
  log("[1/5] Launched app, navigating to an AI chat...");
  await navigateToAiChat();
  screenshot("01-chat-opened");

  log("[2/5] Looking for the download button...");
  const downloadBtn = await waitForElement((t) => t.includes("Скачать"), { timeoutMs: 10000 });
  if (!downloadBtn) {
    fs.writeFileSync(path.join(outDir, "no-download-button.xml"), dumpUiTree());
    screenshot("02-no-download-button");
    log("RESULT: no download button found — model may already be downloaded, or eligibility/manifest blocked it. See no-download-button.xml.");
    process.exit(0);
  }
  tap(downloadBtn.center.x, downloadBtn.center.y);
  log("Tapped download button.");
  screenshot("02-download-started");

  log(`[3/5] Polling until ${KILL_AFTER_BYTES} bytes downloaded, then force-stopping to test resume...`);
  let bytesBeforeKill = 0;
  let killed = false;
  let deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline && !killed) {
    await sleep(2000);
    const bytes = partialFileBytes();
    log(`  partial file: ${bytes} bytes`);
    if (bytes >= KILL_AFTER_BYTES) {
      bytesBeforeKill = bytes;
      killed = true;
    }
  }
  if (!killed) {
    log(`RESULT: FAIL — never reached ${KILL_AFTER_BYTES} bytes within ${POLL_TIMEOUT_MS / 1000}s (download too slow, stalled, or failed — check run.log/logcat).`);
    fs.writeFileSync(path.join(outDir, "logcat.log"), adb(["logcat", "-d", "-v", "time"]).stdout);
    process.exit(1);
  }

  log(`[4/5] Force-stopping at ${bytesBeforeKill} bytes, relaunching, checking the file didn't reset...`);
  adb(["shell", "am", "force-stop", APP_ID]);
  await sleep(2500);
  adb(["shell", "am", "start", "-n", LAUNCHER]);
  await navigateToAiChat();
  screenshot("03-after-relaunch");
  const bytesAfterRelaunch = partialFileBytes();
  log(`  bytes immediately after relaunch: ${bytesAfterRelaunch} (pre-kill was ${bytesBeforeKill})`);
  if (bytesAfterRelaunch < bytesBeforeKill) {
    log(`RESULT: FAIL — file shrank/reset after relaunch (${bytesBeforeKill} -> ${bytesAfterRelaunch}), resume did not happen.`);
    fs.writeFileSync(path.join(outDir, "logcat.log"), adb(["logcat", "-d", "-v", "time"]).stdout);
    process.exit(1);
  }

  log("[5/5] Confirming the file keeps growing past the pre-kill size (genuine resume, not a stall)...");
  deadline = Date.now() + POLL_TIMEOUT_MS;
  let grew = false;
  while (Date.now() < deadline) {
    await sleep(2000);
    const bytes = partialFileBytes();
    log(`  partial file: ${bytes} bytes`);
    if (bytes > bytesBeforeKill + 1_000_000) {
      grew = true;
      break;
    }
  }
  screenshot("04-final");
  const logcat = adb(["logcat", "-d", "-v", "time"]).stdout;
  fs.writeFileSync(path.join(outDir, "logcat.log"), logcat);
  const rangeRequests = logcat.split("\n").filter((l) => l.includes('"Range"'));
  log(`Range-header HTTP requests seen this run: ${rangeRequests.length}`);
  for (const l of rangeRequests.slice(-5)) log("  " + l.trim());

  if (!grew) {
    log("RESULT: FAIL — file did not grow past the pre-kill size after relaunch (resumed connection stalled or never restarted).");
    process.exit(1);
  }
  log(`RESULT: PASS — download resumed from ${bytesBeforeKill} bytes after a real force-stop + relaunch, not from 0.`);
}

main().catch((err) => {
  log(`RESULT: FAIL — ${err.message}`);
  process.exit(1);
});
