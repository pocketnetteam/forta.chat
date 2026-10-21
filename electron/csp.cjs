/**
 * Content-Security-Policy for the packaged desktop app (audit S10-05).
 *
 * The app had no CSP anywhere. The owner chose to start on Electron with a
 * report-only policy (2026-10-10): it blocks nothing, and every violation lands
 * in the main-process log, so the policy can be narrowed and made enforcing
 * once the logs are clean. The policy names what the app is known to need:
 * inline polyfills, blob: and wasm for media and local AI, and connections to
 * any homeserver, proxy or Bastyon node (their hosts are chosen at run time).
 */

const CSP_REPORT_ONLY_POLICY = [
  "default-src 'self' app:",
  "script-src 'self' app: 'unsafe-inline' 'wasm-unsafe-eval' blob:",
  "style-src 'self' app: 'unsafe-inline'",
  "img-src * data: blob:",
  "media-src * data: blob:",
  "font-src 'self' app: data:",
  "connect-src * data: blob:",
  "worker-src 'self' app: blob:",
  "frame-src https:",
  "object-src 'none'",
  "base-uri 'self'",
].join("; ");

/**
 * The app:// response with the report-only header added to HTML pages; any
 * other file is returned as it is.
 * @param {Response} response
 * @param {string} pathname
 * @returns {Response}
 */
function withReportOnlyCsp(response, pathname) {
  if (!/\.html?$/i.test(pathname)) return response;
  const headers = new Headers(response.headers);
  headers.set("Content-Security-Policy-Report-Only", CSP_REPORT_ONLY_POLICY);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/**
 * Whether a renderer console line is Chromium's report of a CSP violation.
 * @param {unknown} message
 * @returns {boolean}
 */
function isCspViolationMessage(message) {
  return typeof message === "string" && message.includes("Content Security Policy");
}

module.exports = { CSP_REPORT_ONLY_POLICY, withReportOnlyCsp, isCspViolationMessage };
