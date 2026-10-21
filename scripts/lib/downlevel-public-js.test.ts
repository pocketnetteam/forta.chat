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

  it("lowers class fields (Chrome 72) as used by broadcaster.js and the service worker's receiver.js", () => {
    const out = downlevelForOldWebView("class Box { items = []; static kind = 'box'; }\nvar b = new Box();");
    expect(out).not.toMatch(/^\s*items = \[\];/m);
    const run = new Function(`${out}; return [b.items.length, Box.kind];`);
    expect(run()).toEqual([0, "box"]);
  });

  it("lowers a file even when a stray quote would fool a regex scan", () => {
    const tricky = "// don't\nvar re = /'/; var x = a?.b;";
    expect(usesModernOperators(downlevelForOldWebView(tricky))).toBe(false);
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
