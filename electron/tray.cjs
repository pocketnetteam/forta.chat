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

/** @returns {import("electron").NativeImage | null} */
function loadTrayIcon() {
  const candidates = [
    path.join(__dirname, "..", "build", "icons", "tray-16.png"),
    path.join(__dirname, "..", "build", "icons", "tray-32.png"),
    path.join(__dirname, "..", "build", "icons", "512x512.png"),
    path.join(__dirname, "..", "build", "icon.png"),
    path.join(__dirname, "..", "public", "forta-icon.png"),
  ];

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

module.exports = { createAppTray };
