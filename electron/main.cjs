const { app, BrowserWindow, shell, ipcMain, protocol, net, session, dialog } = require("electron");
const path = require("path");
const fs = require("fs");
const { initTor } = require("./tor/index.cjs");

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
try {
  if (require("electron-squirrel-startup") === true) {
    app.quit();
  }
} catch (_) {
  // electron-squirrel-startup only needed for Windows NSIS installs
}

// Register app:// as a privileged scheme (must happen before app.whenReady)
protocol.registerSchemesAsPrivileged([{
  scheme: 'app',
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    corsEnabled: true,
    stream: true,
    codeCache: true,
  },
}]);

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

  // Show when ready to avoid white flash
  win.once("ready-to-show", () => win.show());

  // Forward maximize/unmaximize events to renderer
  win.on("maximize", () => win.webContents.send("win:maximized"));
  win.on("unmaximize", () => win.webContents.send("win:unmaximized"));

  // Window control IPC
  ipcMain.on("win:minimize", () => win.minimize());
  ipcMain.on("win:maximize", () => {
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });
  ipcMain.on("win:close", () => win.close());

  // Save file via native dialog and open after save
  ipcMain.handle("file:save", async (_event, fileName, buffer) => {
    const { filePath } = await dialog.showSaveDialog(win, {
      defaultPath: fileName,
    });
    if (!filePath) return null;
    fs.writeFileSync(filePath, Buffer.from(buffer));
    shell.openPath(filePath);
    return filePath;
  });

  // Open external links in the default browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    // Dev: load from Vite dev server (hot reload)
    win.loadURL(process.env.VITE_DEV_SERVER_URL);
    win.webContents.openDevTools();
  } else {
    // Prod: load via app:// protocol (required for Service Worker registration)
    win.loadURL('app://chat/index.html');
  }
}

let torControl = null;

app.whenReady().then(() => {
  // Handle app:// protocol — serves files from dist/
  protocol.handle('app', (request) => {
    const url = new URL(request.url);
    const filePath = path.join(__dirname, '..', 'dist', url.pathname);
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

    if (status === 'started') {
      await session.defaultSession.setProxy({
        proxyRules: 'socks5://127.0.0.1:9250',
      });
      console.log('Session proxy set to Tor SOCKS5');
    } else if (status === 'stopped' || status === 'failed') {
      await session.defaultSession.setProxy({ mode: 'direct' });
      console.log('Session proxy set to direct');
    }
  });

  // Handle renderer requests to change Tor mode
  ipcMain.handle("tor:set-mode", async (_event, mode) => {
    const newSettings = { ...torControl.settings, enabled3: mode };
    await torControl.settingChanged(newSettings);
    return { status: torControl.state.status, info: torControl.state.info, mode };
  });

  // Let renderer query current Tor status (avoids race on startup)
  ipcMain.handle("tor:get-status", () => ({
    status: torControl.state.status,
    info: torControl.state.info,
    mode: torControl.settings.enabled3,
  }));

  createWindow();

  app.on("activate", () => {
    // macOS: re-create window when dock icon is clicked
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("before-quit", () => {
  if (torControl) torControl.stop();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
