#!/usr/bin/env node
/**
 * Copies third-party assets from node_modules into public/ so the app
 * works offline (Tor, blocked CDN, Android WebView without clearnet).
 */
import { cp, mkdir, access } from "fs/promises";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const emojiSrc = resolve(root, "node_modules/emoji-assets/png/32");
const emojiDest = resolve(root, "public/js/vendor/joypixels/png/32");

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function syncJoyPixelsPng() {
  if (!(await pathExists(emojiSrc))) {
    console.warn(
      "[sync-vendor-assets] emoji-assets not installed — run: npm install",
    );
    return;
  }

  await mkdir(dirname(emojiDest), { recursive: true });
  await cp(emojiSrc, emojiDest, { recursive: true, force: true });
  console.log("[sync-vendor-assets] JoyPixels PNG/32 synced to public/js/vendor/joypixels/png/32");
}

await syncJoyPixelsPng();
