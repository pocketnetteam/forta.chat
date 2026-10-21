/**
 * Keep the app window on the app, and hand only safe links to the OS.
 *
 * A plain link without target="_blank" in a rendered post navigated the whole
 * frameless window to any site, which then got the preload bridge
 * (electronAPI / fetchBridge) with no address bar to give it away; and every
 * window.open URL went to shell.openExternal whatever its scheme (audit S10-04).
 */

const EXTERNAL_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

/**
 * Whether a URL may be handed to shell.openExternal.
 * @param {string} url
 * @returns {boolean}
 */
function isExternalUrlAllowed(url) {
  try {
    return EXTERNAL_PROTOCOLS.has(new URL(url).protocol);
  } catch {
    return false;
  }
}

/**
 * Whether a main-frame navigation stays inside the app: the packaged app://chat
 * pages, or the dev server in development. Compared by protocol and host, since
 * Node's URL gives a custom scheme like app:// the origin "null".
 * @param {string} url
 * @param {string} appUrl the URL the window was loaded from
 * @returns {boolean}
 */
function isAppNavigation(url, appUrl) {
  try {
    const target = new URL(url);
    const app = new URL(appUrl);
    return target.protocol === app.protocol && target.host === app.host;
  } catch {
    return false;
  }
}

/**
 * Wire the guards onto a window's webContents.
 * @param {import("electron").WebContents} webContents
 * @param {{ appUrl: string, openExternal: (url: string) => unknown }} deps
 */
function guardWindowNavigation(webContents, { appUrl, openExternal }) {
  const openOutside = (url) => {
    if (isExternalUrlAllowed(url)) {
      Promise.resolve(openExternal(url)).catch((e) => {
        console.warn("[navigation] openExternal failed:", e);
      });
    } else {
      console.warn("[navigation] blocked a link with a disallowed scheme");
    }
  };

  webContents.setWindowOpenHandler(({ url }) => {
    openOutside(url);
    return { action: "deny" };
  });

  const keepInApp = (event, url) => {
    if (isAppNavigation(url, appUrl)) return;
    event.preventDefault();
    openOutside(url);
  };
  webContents.on("will-navigate", keepInApp);
  webContents.on("will-redirect", keepInApp);
}

module.exports = {
  isExternalUrlAllowed,
  isAppNavigation,
  guardWindowNavigation,
};
