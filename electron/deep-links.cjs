/**
 * Protocol client helpers for forta:// deep links.
 */

const PROTOCOL = "forta";

/**
 * Extract a forta:// (or https://forta.chat/…) URL from process argv.
 * Windows/Linux second-instance and cold-start pass the URL as an arg.
 * @param {string[]} argv
 * @returns {string | null}
 */
function extractDeepLinkFromArgv(argv) {
  if (!Array.isArray(argv)) return null;
  for (const arg of argv) {
    if (typeof arg !== "string") continue;
    if (arg.startsWith(`${PROTOCOL}://`)) return arg;
    if (
      arg.startsWith("https://forta.chat/") ||
      arg.startsWith("https://www.forta.chat/")
    ) {
      return arg;
    }
  }
  return null;
}

/**
 * Register as default handler for forta://.
 * Dev builds need the electron binary + app path for Windows protocol launch.
 * @param {import("electron").App} electronApp
 * @param {boolean} isDev
 */
function registerProtocolClient(electronApp, isDev) {
  if (process.defaultApp || isDev) {
    if (process.argv.length >= 2) {
      electronApp.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [
        pathResolveApp(),
      ]);
    }
  } else {
    electronApp.setAsDefaultProtocolClient(PROTOCOL);
  }
}

/** Absolute path to the app entry (used when re-registering protocol in dev). */
function pathResolveApp() {
  const path = require("path");
  return path.resolve(process.argv[1]);
}

module.exports = {
  PROTOCOL,
  extractDeepLinkFromArgv,
  registerProtocolClient,
};
