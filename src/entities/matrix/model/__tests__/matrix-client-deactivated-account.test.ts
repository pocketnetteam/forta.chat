import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

/**
 * Regression: the M_USER_DEACTIVATED short-circuit in getClient() only ever
 * checked `(e as Error).message` for the errcode substring. But
 * matrix-js-sdk-bastyon's MatrixError builds `.message` from the server's
 * free-text `error` field only (e.g. "This account has been deactivated") —
 * the errcode itself ("M_USER_DEACTIVATED") lives exclusively in `.errcode`
 * (and `.name`), never in `.message`. So for a real deactivated-account
 * response from the homeserver, the substring check could never match, and
 * login would silently fall through into the registration-fallback branch
 * instead of surfacing a clear "account deactivated" error — the exact
 * failure mode this check exists to prevent (ported from bastyon-chat
 * mtrx.js, which has the identical fragile-string-match shape).
 *
 * Source-level regression, following this directory's established
 * convention for matrix-client.ts (see matrix-client-device-id.test.ts):
 * getClient() wires the real Matrix SDK end-to-end (IndexedDB store, sync
 * filters, …), so a full behavioral test would need to stub far more than
 * this one branch — the property under test here is the *shape* of the
 * errcode check, not the SDK's login flow itself.
 */
const getSource = (): string =>
  readFileSync(resolve(__dirname, "../matrix-client.ts"), "utf-8");

const getCatchBlock = (source: string): string => {
  const getClientStart = source.indexOf("async getClient(");
  expect(getClientStart).toBeGreaterThan(-1);
  const catchStart = source.indexOf("} catch (e: unknown) {", getClientStart);
  expect(catchStart).toBeGreaterThan(-1);
  const registerTryStart = source.indexOf("// Try to register", catchStart);
  expect(registerTryStart).toBeGreaterThan(-1);
  return source.slice(catchStart, registerTryStart);
};

describe("matrix-client M_USER_DEACTIVATED — structured errcode check", () => {
  it("checks e.errcode via sdk.MatrixError, not just a substring of e.message", () => {
    const source = getSource();
    const catchBlock = getCatchBlock(source);

    expect(catchBlock).toMatch(/e\s+instanceof\s+sdk\.MatrixError/);
    expect(catchBlock).toMatch(/errcode\s*===\s*"M_USER_DEACTIVATED"/);
  });

  it("the errcode check runs before falling through to the registration attempt", () => {
    const source = getSource();
    const catchBlock = getCatchBlock(source);

    const errcodeCheckIdx = catchBlock.indexOf('errcode === "M_USER_DEACTIVATED"');
    const returnNullIdx = catchBlock.indexOf("return null;");
    expect(errcodeCheckIdx).toBeGreaterThan(-1);
    expect(returnNullIdx).toBeGreaterThan(errcodeCheckIdx);
  });

  it("keeps the string-match fallback for non-MatrixError rejections (e.g. a raw string throw)", () => {
    const source = getSource();
    const catchBlock = getCatchBlock(source);

    // Both conditions must be OR'd together — dropping the fallback would
    // regress the (still-possible) case of a bare string/non-MatrixError throw.
    expect(catchBlock).toMatch(
      /errcode === "M_USER_DEACTIVATED" \|\| errStr\.indexOf\("M_USER_DEACTIVATED"\) > -1/,
    );
  });
});
