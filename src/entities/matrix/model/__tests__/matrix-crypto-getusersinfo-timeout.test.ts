import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

/**
 * Regression for WEE-90 H1 (images spin forever).
 *
 * Root cause: `getusersinfo` resolved participants' encryption keys via an
 * UNBOUNDED Pocketnet RPC (`getUsersInfoCb` → loadUsersInfo →
 * psdk.userInfo.load). A blocked/slow node — typical under RU ISP filtering —
 * left that call pending forever, which wedged `decryptKey`, so the media
 * `download()` promise never settled and the image spinner spun indefinitely.
 *
 * Fix: bound the RPC with `withTimeout`. On timeout we proceed with whatever
 * keys are already cached (do NOT clear `usersinfo`); a genuine key gap then
 * fails decrypt deterministically and the download path surfaces error+retry
 * instead of an eternal spinner.
 *
 * The real call requires WebCrypto + miscreant + a fully-built room object and
 * is impractical to mock, so we assert the source shape (same pattern as the
 * other matrix-crypto regression tests in this directory).
 */
const getSource = (): string =>
  readFileSync(resolve(__dirname, "../matrix-crypto.ts"), "utf-8");

const getGetusersinfo = (source: string): string => {
  const start = source.indexOf("async function getusersinfo");
  expect(start, "getusersinfo must exist").toBeGreaterThan(-1);
  const end = source.indexOf("\n    }", start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
};

describe("matrix-crypto getusersinfo — bounded key RPC (WEE-90 H1)", () => {
  it("imports the shared withTimeout helper", () => {
    const source = getSource();
    expect(source).toMatch(/import\s*\{\s*withTimeout\s*\}\s*from\s*["']@\/shared\/lib\/with-timeout["']/);
  });

  it("wraps the getUsersInfoCb call in withTimeout with a named ceiling", () => {
    const block = getGetusersinfo(getSource());
    expect(block).toMatch(/withTimeout\(\s*pcrypto\.getUsersInfoCb\(us\)\s*,\s*GETUSERSINFO_TIMEOUT_MS/);
  });

  it("defines a finite timeout constant", () => {
    const source = getSource();
    expect(source).toMatch(/GETUSERSINFO_TIMEOUT_MS\s*=\s*[\d_]+/);
  });

  it("swallows the timeout/error and returns instead of hanging or throwing", () => {
    const block = getGetusersinfo(getSource());
    // A try/catch around the bounded RPC; the catch returns (does not rethrow)
    // so decryptKey/prepare continue with cached keys rather than wedging.
    expect(block).toMatch(/catch\s*\([\s\S]*?\)\s*\{[\s\S]*?return;[\s\S]*?\}/);
  });

  it("does not clear usersinfo before the RPC resolves (preserves cached keys on timeout)", () => {
    const block = getGetusersinfo(getSource());
    // `usersinfo = {}` must come AFTER the awaited RPC, so a timeout leaves the
    // previously-resolved keys intact.
    const rpcIdx = block.indexOf("withTimeout(");
    const clearIdx = block.indexOf("usersinfo = {}");
    expect(rpcIdx).toBeGreaterThan(-1);
    expect(clearIdx).toBeGreaterThan(rpcIdx);
  });
});
