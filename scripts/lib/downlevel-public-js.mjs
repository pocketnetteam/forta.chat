import { transformSync } from "esbuild";

const STRING_LITERALS = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g;

/**
 * True when a script uses `?.` or `??` outside string literals. A rough check
 * for tests only — the string stripper is a regex, not a lexer, so it must not
 * decide what gets lowered.
 *
 * @param {string} code
 * @returns {boolean}
 */
export function usesModernOperators(code) {
  return /\?\.(?!\d)|\?\?/.test(code.replace(STRING_LITERALS, ""));
}

/**
 * Lower the syntax of a classic public/js script to the same target the Vite
 * bundle uses (audit W2B-05). public/js holds the Bastyon SDK (sdk.js,
 * actions.js, kit.js, satolist.js, ...) that Vite copies verbatim, and terser
 * only minifies — so `?.` / `??` (Chrome 80) and class fields (Chrome 72, in
 * broadcaster.js and the service worker's receiver.js) reached old Android
 * System WebView, which threw "SyntaxError: Unexpected token ." and left login
 * and registration without the SDK.
 *
 * Every script is lowered: esbuild leaves code that is already chrome60-safe
 * as it is, and a heuristic gate could skip a file that needs lowering. No
 * module format is set: with `format: "cjs"` esbuild assumes `exports` exists
 * and folds the UMD checks in underscore/moment/joypixels into
 * `exports.x = ...`, which throws "exports is not defined" in the browser.
 *
 * @param {string} code
 * @returns {string}
 */
export function downlevelForOldWebView(code) {
  return transformSync(code, { loader: "js", target: "chrome60" }).code;
}
