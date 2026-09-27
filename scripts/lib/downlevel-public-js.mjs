import { transformSync } from "esbuild";

const STRING_LITERALS = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g;

/**
 * True when a script uses `?.` or `??` outside string literals. Crude on
 * purpose: a false positive only costs a no-op transform.
 *
 * @param {string} code
 * @returns {boolean}
 */
export function usesModernOperators(code) {
  return /\?\.(?!\d)|\?\?/.test(code.replace(STRING_LITERALS, ""));
}

/**
 * Lower the syntax of a classic public/js script to the same target the Vite
 * bundle uses (audit W2B-01 follow-up). public/js holds the Bastyon SDK
 * (sdk.js, actions.js, kit.js, satolist.js, ...) that Vite copies verbatim, and
 * terser only minifies — so `?.` and `??` reached Android System WebView < 80,
 * which threw "SyntaxError: Unexpected token ." and left login and
 * registration without the SDK.
 *
 * Only scripts that use those operators are touched, and no module format is
 * set: with `format: "cjs"` esbuild assumes `exports` exists and folds the UMD
 * checks in underscore/moment/joypixels into `exports.x = ...`, which throws
 * "exports is not defined" in the browser.
 *
 * @param {string} code
 * @returns {string}
 */
export function downlevelForOldWebView(code) {
  if (!usesModernOperators(code)) return code;
  return transformSync(code, { loader: "js", target: "chrome60" }).code;
}
