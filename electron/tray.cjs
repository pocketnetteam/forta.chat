/**
 * System tray for Forta Chat desktop.
 * Close-to-tray hides the window; Quit from the menu exits fully.
 */

const path = require("path");
const { Tray, Menu, nativeImage } = require("electron");

/**
 * @param {object} opts
 * @param {() => void} opts.onShow
 * @param {() => void} opts.onQuit
 * @returns {import("electron").Tray | null}
 */
function createAppTray({ onShow, onQuit }) {
  const icon = loadTrayIcon();
  if (!icon || icon.isEmpty()) {
    console.warn("[tray] icon missing — tray disabled");
    return null;
  }

  const tray = new Tray(icon);
  tray.setToolTip("Forta Chat");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: "Show Forta Chat",
        click: () => onShow(),
      },
      { type: "separator" },
      {
        label: "Quit",
        click: () => onQuit(),
      },
    ]),
  );
  tray.on("double-click", () => onShow());
  // Linux often uses single click to open the menu; mac/win double-click show.
  if (process.platform === "win32") {
    tray.on("click", () => onShow());
  }

  return tray;
}

/**
 * Where the tray icon may be. electron-builder packs only dist/ and electron/,
 * so build/ and public/ exist in a dev run alone; dist/forta-icon.png (Vite's
 * copy of public/) is what a packaged app finds. Without it the tray never
 * appeared and "close to tray" hid the window for good (audit S8-03).
 * @param {string} baseDir the electron/ directory
 * @returns {string[]}
 */
function trayIconCandidates(baseDir) {
  return [
    path.join(baseDir, "..", "build", "icons", "tray-16.png"),
    path.join(baseDir, "..", "build", "icons", "tray-32.png"),
    path.join(baseDir, "..", "build", "icons", "512x512.png"),
    path.join(baseDir, "..", "build", "icon.png"),
    path.join(baseDir, "..", "public", "forta-icon.png"),
    path.join(baseDir, "..", "dist", "forta-icon.png"),
  ];
}

/** @returns {import("electron").NativeImage | null} */
function loadTrayIcon() {
  const candidates = trayIconCandidates(__dirname);

  for (const file of candidates) {
    try {
      const img = nativeImage.createFromPath(file);
      if (!img.isEmpty()) {
        // Tray icons look best small; resize when we fell back to the 512 master.
        if (img.getSize().width > 32) {
          return img.resize({ width: 16, height: 16 });
        }
        return img;
      }
    } catch {
      // try next
    }
  }
  return null;
}

module.exports = { createAppTray, trayIconCandidates };
