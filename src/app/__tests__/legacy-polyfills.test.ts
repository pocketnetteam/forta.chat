import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createContext, runInContext } from "node:vm";
import { describe, expect, it } from "vitest";

/**
 * Audit W2B-02 regression tests for public/legacy-polyfills.js. The file runs
 * as a classic script before the bundle on old Android System WebView builds
 * (WebView 66 died on `crypto.randomUUID is not a function` at module load).
 * Node has every one of these APIs, so each test builds a fresh VM realm,
 * deletes the native versions, runs the real file there and checks behaviour.
 */

const SOURCE = readFileSync(resolve(__dirname, "../../../public/legacy-polyfills.js"), "utf8");
const html = readFileSync(resolve(__dirname, "../../../index.html"), "utf8");

const REMOVE_NATIVES = `
  delete Promise.allSettled;
  delete Array.prototype.flat;
  delete Array.prototype.flatMap;
  delete Array.prototype.at;
  delete Array.prototype.findLast;
  delete Array.prototype.findLastIndex;
  delete Array.prototype.toSorted;
  delete String.prototype.at;
  delete String.prototype.replaceAll;
  delete String.prototype.matchAll;
  delete Object.fromEntries;
  delete Object.hasOwn;
`;

function oldWebView() {
  const cryptoStub = {
    getRandomValues: (bytes: Uint8Array) => {
      for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 37 + 11) & 0xff;
      return bytes;
    },
  };
  const context = createContext({ crypto: cryptoStub, setTimeout });
  runInContext("var window = this;" + REMOVE_NATIVES, context);
  runInContext(SOURCE, context);
  return (code: string): unknown => runInContext(code, context);
}

describe("public/legacy-polyfills.js (audit W2B-02)", () => {
  it("is loaded by index.html as a classic script before the module entry", () => {
    const tag = html.indexOf('src="./legacy-polyfills.js"');
    expect(tag).toBeGreaterThan(-1);
    expect(tag).toBeLessThan(html.indexOf('type="module"'));
  });

  it("adds crypto.randomUUID that returns an RFC 4122 v4 id", () => {
    const run = oldWebView();
    expect(run("crypto.randomUUID()")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("adds Promise.allSettled with the standard result shape", async () => {
    const run = oldWebView();
    const result = await (run("Promise.allSettled([Promise.resolve(1), Promise.reject('x'), 3])") as Promise<unknown>);
    expect(JSON.parse(JSON.stringify(result))).toEqual([
      { status: "fulfilled", value: 1 },
      { status: "rejected", reason: "x" },
      { status: "fulfilled", value: 3 },
    ]);
  });

  it("adds the array helpers", () => {
    const run = oldWebView();
    expect(run("JSON.stringify([1, [2, [3, [4]]]].flat())")).toBe("[1,2,[3,[4]]]");
    expect(run("JSON.stringify([1, [2, [3]]].flat(Infinity))")).toBe("[1,2,3]");
    expect(run("JSON.stringify([1, 2].flatMap(function (x) { return [x, x * 10]; }))")).toBe("[1,10,2,20]");
    expect(run("[5, 6, 7].at(-1)")).toBe(7);
    expect(run("[5, 6, 7].at(3)")).toBeUndefined();
    expect(run("[1, 2, 3, 4].findLast(function (x) { return x % 2 === 1; })")).toBe(3);
    expect(run("[1, 2, 3, 4].findLastIndex(function (x) { return x > 9; })")).toBe(-1);
    expect(run("var a = [3, 1, 2]; JSON.stringify([a.toSorted(), a])")).toBe("[[1,2,3],[3,1,2]]");
  });

  it("adds the string helpers", () => {
    const run = oldWebView();
    expect(run("'abc'.at(-1)")).toBe("c");
    expect(run("'a.b.c'.replaceAll('.', '-')")).toBe("a-b-c");
    expect(run("'x1y22'.replaceAll(/\\d/g, '#')")).toBe("x#y##");
    expect(run("JSON.stringify(Array.from('a1b22'.matchAll(/\\d+/g), function (m) { return [m[0], m.index]; }))")).toBe(
      '[["1",1],["22",3]]',
    );
    // The TypeError comes from the VM realm, so match the message, not the class.
    expect(() => run("'a'.matchAll(/a/)")).toThrow(/global RegExp/);
  });

  it("adds Object.fromEntries and Object.hasOwn", () => {
    const run = oldWebView();
    expect(run("JSON.stringify(Object.fromEntries([['a', 1], ['b', 2]]))")).toBe('{"a":1,"b":2}');
    expect(run("Object.hasOwn({ k: 1 }, 'k') && !Object.hasOwn({}, 'toString')")).toBe(true);
  });

  it("does not replace an API the WebView already has", () => {
    const context = createContext({ setTimeout });
    runInContext("var window = this; var native = Array.prototype.flat;", context);
    runInContext(SOURCE, context);
    expect(runInContext("Array.prototype.flat === native", context)).toBe(true);
  });
});
