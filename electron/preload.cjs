const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  isElectron: true,
  platform: process.platform,
  minimize: () => ipcRenderer.send("win:minimize"),
  maximize: () => ipcRenderer.send("win:maximize"),
  close: () => ipcRenderer.send("win:close"),
  show: () => ipcRenderer.send("win:show"),
  onMaximized: (cb) => ipcRenderer.on("win:maximized", cb),
  onUnmaximized: (cb) => ipcRenderer.on("win:unmaximized", cb),
  torSetMode: (mode) => ipcRenderer.invoke("tor:set-mode", mode),
  torConfigure: (opts) => ipcRenderer.invoke("tor:configure", opts),
  torGetStatus: () => ipcRenderer.invoke("tor:get-status"),
  onTorStatus: (cb) =>
    ipcRenderer.on("tor:status-changed", (_e, data) => cb(data)),
  saveFile: (fileName, buffer) =>
    ipcRenderer.invoke("file:save", fileName, buffer),
  getDesktopSettings: () => ipcRenderer.invoke("app:get-desktop-settings"),
  setDesktopSettings: (patch) =>
    ipcRenderer.invoke("app:set-desktop-settings", patch),
  setBadgeCount: (count) => ipcRenderer.invoke("app:set-badge-count", count),
  setZoomFactor: (factor) => ipcRenderer.invoke("app:set-zoom-factor", factor),
  getZoomFactor: () => ipcRenderer.invoke("app:get-zoom-factor"),
  onDeepLink: (cb) => {
    const listener = (_e, url) => cb(url);
    ipcRenderer.on("deep-link:open", listener);
    return () => ipcRenderer.removeListener("deep-link:open", listener);
  },
  getUpdateStatus: () => ipcRenderer.invoke("update:get-status"),
  checkForUpdates: () => ipcRenderer.invoke("update:check"),
  quitAndInstallUpdate: () => ipcRenderer.invoke("update:quit-and-install"),
  onUpdateStatus: (cb) => {
    const channels = [
      "update:checking",
      "update:available",
      "update:not-available",
      "update:progress",
      "update:downloaded",
      "update:error",
    ];
    const listener = (_e, payload) => cb(payload);
    for (const ch of channels) ipcRenderer.on(ch, listener);
    return () => {
      for (const ch of channels) ipcRenderer.removeListener(ch, listener);
    };
  },
});

// Scoped IPC bridge for Service Worker ↔ Main process fetch proxy (Tor transport)
contextBridge.exposeInMainWorld("fetchBridge", {
  send: (channel, ...args) => {
    if (typeof channel === "string" && channel.startsWith("FetchBridge:"))
      ipcRenderer.send(channel, ...args);
  },
  on: (channel, cb) => {
    if (typeof channel === "string" && channel.startsWith("FetchBridge:"))
      ipcRenderer.on(channel, (_e, ...args) => cb(null, ...args));
  },
  invoke: (channel, ...args) => {
    if (channel === "AltTransportActive")
      return ipcRenderer.invoke(channel, ...args);
  },
});
