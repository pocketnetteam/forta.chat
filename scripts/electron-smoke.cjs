/**
 * CI / local smoke: require dist/, boot Electron, wait for "[smoke] ok", exit.
 * Usage: npx vite build && node scripts/electron-smoke.cjs
 */

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");

const root = path.join(__dirname, "..");
const distIndex = path.join(root, "dist", "index.html");
const TIMEOUT_MS = Number(process.env.FORTA_ELECTRON_SMOKE_TIMEOUT_MS || 90_000);

if (!fs.existsSync(distIndex)) {
  console.error(
    "[electron-smoke] dist/index.html missing — run `npx vite build` first",
  );
  process.exit(1);
}

const requireFromRoot = createRequire(path.join(root, "package.json"));
/** @type {string} */
const electronBin = requireFromRoot("electron");

const child = spawn(electronBin, ["."], {
  cwd: root,
  env: {
    ...process.env,
    FORTA_ELECTRON_SMOKE: "1",
    FORTA_DISABLE_AUTO_UPDATE: "1",
    // Ubuntu runners: Chromium sandbox often needs this under xvfb
    ELECTRON_DISABLE_SANDBOX:
      process.env.ELECTRON_DISABLE_SANDBOX ??
      (process.platform === "linux" ? "1" : undefined),
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let sawOk = false;
let settled = false;

/** @param {Buffer | string} chunk */
function consume(chunk) {
  const text = String(chunk);
  process.stdout.write(text);
  if (text.includes("[smoke] ok")) sawOk = true;
}

child.stdout.on("data", consume);
child.stderr.on("data", (chunk) => {
  process.stderr.write(chunk);
  consume(chunk);
});

const timer = setTimeout(() => {
  if (settled) return;
  console.error(`[electron-smoke] timeout after ${TIMEOUT_MS}ms`);
  child.kill("SIGKILL");
}, TIMEOUT_MS);

child.on("error", (err) => {
  clearTimeout(timer);
  console.error("[electron-smoke] spawn failed:", err);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (settled) return;
  settled = true;
  clearTimeout(timer);
  if (sawOk && (code === 0 || code === null)) {
    process.exit(0);
  }
  console.error(
    `[electron-smoke] failed (ok=${sawOk}, code=${code}, signal=${signal})`,
  );
  process.exit(code && code !== 0 ? code : 1);
});
