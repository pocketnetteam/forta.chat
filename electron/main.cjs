const {
  app,
  BrowserWindow,
  shell,
  ipcMain,
  protocol,
  net,
  session,
  dialog,
} = require("electron");
const path = require("path");
const fs = require("fs");
const { initTor } = require("./tor/index.cjs");
const {
  loadDesktopSettings,
  saveDesktopSettings,
} = require("./desktop-settings.cjs");
const {
  extractDeepLinkFromArgv,
  registerProtocolClient,
} = require("./deep-links.cjs");
const { createAppTray } = require("./tray.cjs");
const { initAutoUpdater } = require("./auto-updater.cjs");

const isDev = !!process.env.VITE_DEV_SERVER_URL;
const wantDevTools =
  isDev ||
  process.env.FORTA_DEVTOOLS === "1" ||
  process.argv.includes("--devtools");

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
try {
  if (require("electron-squirrel-startup") === true) {
    app.quit();
  }
} catch (_) {
  // electron-squirrel-startup only needed for Windows NSIS installs
}

// Single instance: second launch focuses the existing window (+ forwards deep link)
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  bootElectronApp();
}

function bootElectronApp() {
  /** @type {import("electron").BrowserWindow | null} */
  let mainWindow = null;
  /** @type {ReturnType<typeof initTor>["torControl"] | null} */
  let torControl = null;
  /** @type {import("electron").Tray | null} */
  let tray = null;
  let windowIpcRegistered = false;
  /** When true, window close quits instead of hiding to tray. */
  let isQuitting = false;
  /** Desktop prefs (close-to-tray / open-at-login). */
  let desktopSettings = loadDesktopSettings();
  /** Deep link URL received before the renderer was ready. */
  let pendingDeepLink = extractDeepLinkFromArgv(process.argv);

  app.on("second-instance", (_event, argv) => {
    const url = extractDeepLinkFromArgv(argv);
    if (url) deliverDeepLink(url);
    focusMainWindow();
  });

  // macOS: cold/warm open via forta://
  app.on("open-url", (event, url) => {
    event.preventDefault();
    deliverDeepLink(url);
    focusMainWindow();
  });

  // Register app:// as a privileged scheme (must happen before app.whenReady)
  protocol.registerSchemesAsPrivileged([
    {
      scheme: "app",
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
        codeCache: true,
      },
    },
  ]);

  function focusMainWindow() {
    const win = mainWindow ?? BrowserWindow.getAllWindows()[0];
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }

  /** @param {string} url */
  function deliverDeepLink(url) {
    if (!url || typeof url !== "string") return;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("deep-link:open", url);
    } else {
      pendingDeepLink = url;
    }
  }

  function flushPendingDeepLink() {
    if (!pendingDeepLink || !mainWindow || mainWindow.isDestroyed()) return;
    const url = pendingDeepLink;
    pendingDeepLink = null;
    mainWindow.webContents.send("deep-link:open", url);
  }

  function quitApp() {
    isQuitting = true;
    app.quit();
  }

  /**
   * Badge / taskbar unread count (dock on macOS, overlay on Win/Linux).
   * @param {number} count
   */
  function setBadgeCount(count) {
    const safe = Math.max(0, Math.floor(Number(count) || 0));
    app.setBadgeCount(safe);
  }

  function registerWindowIpc() {
    if (windowIpcRegistered) return;
    windowIpcRegistered = true;

    ipcMain.on("win:minimize", () => {
      mainWindow?.minimize();
    });
    ipcMain.on("win:maximize", () => {
      if (!mainWindow) return;
      if (mainWindow.isMaximized()) mainWindow.unmaximize();
      else mainWindow.maximize();
    });
    ipcMain.on("win:close", () => {
      mainWindow?.close();
    });
    ipcMain.on("win:show", () => {
      focusMainWindow();
    });

    ipcMain.handle("file:save", async (_event, fileName, buffer) => {
      if (!mainWindow) return null;
      const { filePath } = await dialog.showSaveDialog(mainWindow, {
        defaultPath: fileName,
      });
      if (!filePath) return null;
      fs.writeFileSync(filePath, Buffer.from(buffer));
      shell.openPath(filePath);
      return filePath;
    });

    ipcMain.handle("app:get-desktop-settings", () => ({ ...desktopSettings }));

    ipcMain.handle("app:set-desktop-settings", (_event, patch) => {
      if (!patch || typeof patch !== "object") return { ...desktopSettings };
      const next = saveDesktopSettings({
        ...(typeof patch.closeToTray === "boolean"
          ? { closeToTray: patch.closeToTray }
          : {}),
        ...(typeof patch.openAtLogin === "boolean"
          ? { openAtLogin: patch.openAtLogin }
          : {}),
      });
      desktopSettings = next;
      if (typeof patch.openAtLogin === "boolean") {
        app.setLoginItemSettings({
          openAtLogin: next.openAtLogin,
          openAsHidden: false,
        });
      }
      return { ...desktopSettings };
    });

    ipcMain.handle("app:set-badge-count", (_event, count) => {
      setBadgeCount(count);
    });

    ipcMain.handle("app:set-zoom-factor", (_event, factor) => {
      const win = mainWindow;
      if (!win || win.isDestroyed()) return 1;
      const next = Math.min(2, Math.max(0.5, Number(factor) || 1));
      win.webContents.setZoomFactor(next);
      return next;
    });

    ipcMain.handle("app:get-zoom-factor", () => {
      const win = mainWindow;
      if (!win || win.isDestroyed()) return 1;
      return win.webContents.getZoomFactor();
    });
  }

  function wireZoomShortcuts(win) {
    win.webContents.on("before-input-event", (event, input) => {
      if (input.type !== "keyDown") return;
      const mod = input.control || input.meta;
      if (!mod) return;

      const key = input.key;
      let delta = 0;
      if (key === "=" || key === "+" || key === "Add") delta = 0.1;
      else if (key === "-" || key === "Subtract") delta = -0.1;
      else if (key === "0" || key === "Numpad0") {
        win.webContents.setZoomFactor(1);
        event.preventDefault();
        return;
      } else {
        return;
      }

      const current = win.webContents.getZoomFactor();
      const next = Math.min(2, Math.max(0.5, Math.round((current + delta) * 10) / 10));
      win.webContents.setZoomFactor(next);
      event.preventDefault();
    });
  }

  function createWindow() {
    const win = new BrowserWindow({
      width: 1100,
      height: 750,
      minWidth: 380,
      minHeight: 500,
      title: "Forta Chat",
      webPreferences: {
        preload: path.join(__dirname, "preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
      },
      // Frameless — custom title bar drawn by the renderer
      frame: false,
      // macOS: keep native traffic lights but overlay them on our custom bar
      titleBarStyle: process.platform === "darwin" ? "hiddenInset" : undefined,
      backgroundColor: "#1a1a2e",
      show: false,
    });

    mainWindow = win;
    win.on("closed", () => {
      if (mainWindow === win) mainWindow = null;
    });

    // Close → tray (when enabled); Quit from tray sets isQuitting.
    win.on("close", (event) => {
      if (isQuitting || !desktopSettings.closeToTray) return;
      event.preventDefault();
      win.hide();
      // macOS: hiding leaves the app in dock; fine for messenger UX.
    });

    // Show when ready to avoid white flash
    win.once("ready-to-show", () => win.show());

    win.webContents.on("did-finish-load", () => {
      flushPendingDeepLink();
    });

    // Forward maximize/unmaximize events to renderer
    win.on("maximize", () => win.webContents.send("win:maximized"));
    win.on("unmaximize", () => win.webContents.send("win:unmaximized"));

    registerWindowIpc();
    wireZoomShortcuts(win);

    // Open external links in the default browser
    win.webContents.setWindowOpenHandler(({ url }) => {
      shell.openExternal(url);
      return { action: "deny" };
    });

    // Mic / camera for calls
    win.webContents.session.setPermissionRequestHandler(
      (_wc, permission, callback) => {
        const allowed = ["media", "notifications", "display-capture"];
        callback(allowed.includes(permission));
      },
    );

    if (isDev) {
      win.loadURL(process.env.VITE_DEV_SERVER_URL);
    } else {
      win.loadURL("app://chat/index.html");
    }

    if (wantDevTools) {
      win.webContents.openDevTools({ mode: "detach" });
    }
  }

  app.whenReady().then(() => {
    registerProtocolClient(app, isDev);
    desktopSettings = loadDesktopSettings();
    app.setLoginItemSettings({
      openAtLogin: desktopSettings.openAtLogin,
      openAsHidden: false,
    });

    // Handle app:// protocol — serves files from dist/
    protocol.handle("app", (request) => {
      const url = new URL(request.url);
      const filePath = path.join(__dirname, "..", "dist", url.pathname);
      return net.fetch(`file://${filePath}`);
    });

    // Initialise Tor transport stack
    const tor = initTor(ipcMain);
    torControl = tor.torControl;

    // Broadcast Tor status changes to all renderer windows
    // and toggle the session-level SOCKS proxy so all renderer
    // network requests (fetch, XHR, WebSocket) go through Tor.
    torControl.onAny(async (status) => {
      const data = { status, info: torControl.state.info };
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send("tor:status-changed", data);
      }

      if (status === "started") {
        await session.defaultSession.setProxy({
          proxyRules: "socks5://127.0.0.1:9250",
        });
        console.log("Session proxy set to Tor SOCKS5");
      } else if (status === "stopped" || status === "failed") {
        await session.defaultSession.setProxy({ mode: "direct" });
        console.log("Session proxy set to direct");
      }
    });

    // Handle renderer requests to change Tor mode (legacy)
    ipcMain.handle("tor:set-mode", async (_event, mode) => {
      const newSettings = { ...torControl.settings, enabled3: mode };
      await torControl.settingChanged(newSettings);
      return { status: torControl.state.status, info: torControl.state.info, mode };
    });

    // Full Tor configure: mode + Snowflake bridge
    ipcMain.handle("tor:configure", async (_event, { mode, useSnowFlake2 }) => {
      const newSettings = {
        ...torControl.settings,
        enabled3: mode,
        ...(typeof useSnowFlake2 === "boolean" ? { useSnowFlake2 } : {}),
      };
      await torControl.settingChanged(newSettings);
      return {
        status: torControl.state.status,
        info: torControl.state.info,
        mode: newSettings.enabled3,
        useSnowFlake2: newSettings.useSnowFlake2,
      };
    });

    // Let renderer query current Tor status (avoids race on startup)
    ipcMain.handle("tor:get-status", () => ({
      status: torControl.state.status,
      info: torControl.state.info,
      mode: torControl.settings.enabled3,
      useSnowFlake2: torControl.settings.useSnowFlake2,
    }));

    tray = createAppTray({
      onShow: () => focusMainWindow(),
      onQuit: () => quitApp(),
    });

    createWindow();

    initAutoUpdater({
      BrowserWindow,
      ipcMain,
      isDev,
      prepareForQuit: () => {
        isQuitting = true;
      },
    });

    app.on("activate", () => {
      // macOS: re-create window when dock icon is clicked
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
      else focusMainWindow();
    });
  });

  app.on("before-quit", () => {
    isQuitting = true;
    if (torControl) torControl.stop();
  });

  app.on("window-all-closed", () => {
    // With close-to-tray the window is hidden, not destroyed — this only
    // fires when the last window is actually closed (quit / closeToTray off).
    if (process.platform !== "darwin") {
      if (!desktopSettings.closeToTray || isQuitting) app.quit();
    }
  });
}
