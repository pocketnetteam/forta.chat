/**
 * Minimal `adb`/`uiautomator` driving helpers — finds elements by their
 * on-screen text (works against WebView content too, Chromium exposes it
 * through the accessibility tree `uiautomator dump` reads) instead of
 * hardcoded pixel coordinates, which broke repeatedly during manual device
 * testing whenever the layout shifted a few pixels (error text pushing a
 * button down, etc — see docs/plans/llama2/device-ai-loop.md).
 */
import { spawnSync } from "node:child_process";
import { findAdb } from "../find-adb.mjs";

const adbPath = findAdb();

/** @returns {import('node:child_process').SpawnSyncReturns<string>} */
export function adb(args) {
  return spawnSync(adbPath, args, { encoding: "utf8" });
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function dumpUiTree() {
  adb(["shell", "uiautomator", "dump", "/sdcard/ui_dump.xml"]);
  return adb(["shell", "cat", "/sdcard/ui_dump.xml"]).stdout;
}

function* iterNodeTags(xml) {
  const nodeRe = /<node\b[^>]*>/g;
  let match;
  while ((match = nodeRe.exec(xml))) yield match[0];
}

function attr(nodeTag, name) {
  const match = new RegExp(`${name}="([^"]*)"`).exec(nodeTag);
  return match ? match[1] : "";
}

/**
 * @param {string} xml
 * @param {(text: string, contentDesc: string) => boolean} matcher
 * @returns {{ text: string, desc: string, bounds: {x1:number,y1:number,x2:number,y2:number}, center: {x:number,y:number} } | null}
 */
export function findElement(xml, matcher) {
  for (const nodeTag of iterNodeTags(xml)) {
    const text = attr(nodeTag, "text");
    const desc = attr(nodeTag, "content-desc");
    if (!matcher(text, desc)) continue;
    const boundsMatch = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(attr(nodeTag, "bounds"));
    if (!boundsMatch) continue;
    const [x1, y1, x2, y2] = boundsMatch.slice(1).map(Number);
    return { text, desc, bounds: { x1, y1, x2, y2 }, center: { x: Math.round((x1 + x2) / 2), y: Math.round((y1 + y2) / 2) } };
  }
  return null;
}

export function tap(x, y) {
  adb(["shell", "input", "tap", String(x), String(y)]);
}

export function swipe(x1, y1, x2, y2, durationMs = 300) {
  adb(["shell", "input", "swipe", String(x1), String(y1), String(x2), String(y2), String(durationMs)]);
}

/**
 * Polls `uiautomator dump` until `matcher` finds an element, or times out.
 * @param {(text: string, contentDesc: string) => boolean} matcher
 */
export async function waitForElement(matcher, { timeoutMs = 15000, intervalMs = 700 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const el = findElement(dumpUiTree(), matcher);
    if (el) return el;
    if (Date.now() >= deadline) return null;
    await sleep(intervalMs);
  }
}

/** Waits for an element with exact `text`, taps its center, and returns it. Throws if not found in time. */
export async function tapText(text, opts) {
  const el = await waitForElement((t) => t === text, opts);
  if (!el) throw new Error(`Element with text "${text}" not found within timeout`);
  tap(el.center.x, el.center.y);
  return el;
}
