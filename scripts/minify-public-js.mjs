#!/usr/bin/env node
/**
 * Post-build script: minifies all .js files in dist/js/ using terser.
 * Preserves originals in public/js/ for dev mode.
 */
import { readFile, writeFile } from "fs/promises";
import { resolve, relative } from "path";
import pkg from "glob";
const { glob } = pkg;
import { minify } from "terser";

const DIST_JS = resolve("dist/js");

const files = await glob("**/*.js", { cwd: DIST_JS, absolute: true });

let totalBefore = 0;
let totalAfter = 0;

for (const file of files) {
  const code = await readFile(file, "utf-8");
  if (!code.trim()) continue;

  const before = Buffer.byteLength(code);
  totalBefore += before;

  try {
    const result = await minify(code, {
      compress: { passes: 2, drop_console: false },
      mangle: {
        // toplevel: false is the default — top-level vars are NEVER renamed.
        // reserved list is extra insurance for globals shared between scripts.
        reserved: [
          "pSDK", "Api", "Actions", "Account", "Action", "ProxyRequest", "Proxy16",
          "System16", "IpcBridge", "NFT", "HTLS", "Recorder", "BSTMedia", "BSTMediaCs",
          "Broadcaster", "LoadingBar", "Circles", "fkit", "pstranslit",
          "ActionOptions", "Buffer", "bitcoin",
        ],
      },
      format: { comments: false },
      parse: { bare_returns: true },
    });

    if (result.code) {
      const after = Buffer.byteLength(result.code);
      totalAfter += after;
      await writeFile(file, result.code);
      const pct = ((1 - after / before) * 100).toFixed(0);
      console.log(`  ${relative("dist", file)}  ${(before / 1024).toFixed(0)}KB → ${(after / 1024).toFixed(0)}KB  (-${pct}%)`);
    } else {
      totalAfter += before;
    }
  } catch (e) {
    // If minification fails for a file, keep original
    totalAfter += before;
    console.warn(`  ⚠ ${relative("dist", file)}: skipped (${e.message})`);
  }
}

console.log(`\nTotal: ${(totalBefore / 1024).toFixed(0)}KB → ${(totalAfter / 1024).toFixed(0)}KB  (-${((1 - totalAfter / totalBefore) * 100).toFixed(0)}%)`);
