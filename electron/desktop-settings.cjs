/**
 * Persist desktop UX prefs in userData (available before renderer boots).
 * Used by close-to-tray and open-at-login.
 */

const fs = require("fs");
const path = require("path");
const { app } = require("electron");

/** @typedef {{ closeToTray: boolean, openAtLogin: boolean }} DesktopSettings */

const DEFAULTS = /** @type {DesktopSettings} */ ({
  closeToTray: true,
  openAtLogin: false,
});

/** @returns {string} */
function settingsPath() {
  return path.join(app.getPath("userData"), "desktop-settings.json");
}

/** @returns {DesktopSettings} */
function loadDesktopSettings() {
  try {
    const raw = fs.readFileSync(settingsPath(), "utf8");
    const parsed = JSON.parse(raw);
    return {
      closeToTray:
        typeof parsed.closeToTray === "boolean"
          ? parsed.closeToTray
          : DEFAULTS.closeToTray,
      openAtLogin:
        typeof parsed.openAtLogin === "boolean"
          ? parsed.openAtLogin
          : DEFAULTS.openAtLogin,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

/** @param {Partial<DesktopSettings>} patch
 *  @returns {DesktopSettings} */
function saveDesktopSettings(patch) {
  const next = { ...loadDesktopSettings(), ...patch };
  try {
    fs.writeFileSync(settingsPath(), JSON.stringify(next, null, 2), "utf8");
  } catch (e) {
    console.error("[desktop-settings] write failed:", e);
  }
  return next;
}

module.exports = {
  DEFAULTS,
  loadDesktopSettings,
  saveDesktopSettings,
};
