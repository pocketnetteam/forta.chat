import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { downlevelForOldWebView, usesModernOperators } from "./downlevel-public-js.mjs";

/**
 * Audit W2B-01 follow-up: the Bastyon SDK in public/js is copied into dist/js
 * without transpiling, and Android System WebView < 80 rejected its `?.` / `??`
 * with "SyntaxError: Unexpected token ." (seen on an Android 9 emulator,
 * WebView 66), so login and registration had no SDK.
 */

describe("downlevelForOldWebView", () => {
  it("rewrites optional chaining and nullish coalescing", () => {
    const out = downlevelForOldWebView("var x = a?.b?.[c]?.(d) ?? e;");
    expect(usesModernOperators(out)).toBe(false);
    const run = new Function("a", "c", "d", "e", `${out}; return x;`);
    expect(run(undefined, "k", 1, "fallback")).toBe("fallback");
    expect(run({ b: { k: (v: number) => v + 1 } }, "k", 1, "fallback")).toBe(2);
  });

  it("returns scripts without those operators untouched", () => {
    const umd = '!function(n,r){"object"==typeof exports&&"undefined"!=typeof module?module.exports=r():n._=r()}(this,function(){return 1});';
    expect(downlevelForOldWebView(umd)).toBe(umd);
  });

  it("keeps a UMD wrapper working as a browser global after lowering", () => {
    const umd = '!function(n,r){"object"==typeof exports&&"undefined"!=typeof module?module.exports=r():n.lib=r()}(this,function(){return {v:{w:2}}?.v?.w ?? 0});';
    const out = downlevelForOldWebView(umd);
    const browserGlobal: { lib?: number } = {};
    new Function(out).call(browserGlobal);
    expect(browserGlobal.lib).toBe(2);
  });

  it("lowers the real SDK scripts that failed on WebView 66", () => {
    for (const file of ["lib/client/sdk.js", "lib/client/actions.js", "kit.js", "satolist.js", "buildChat.js"]) {
      const source = readFileSync(resolve(__dirname, "../../public/js", file), "utf8");
      expect(usesModernOperators(source), `${file} fixture should use ?. or ??`).toBe(true);
      expect(usesModernOperators(downlevelForOldWebView(source)), file).toBe(false);
    }
  });
});
