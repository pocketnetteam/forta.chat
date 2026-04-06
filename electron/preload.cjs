const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  isElectron: true,
  platform: process.platform,
  minimize: () => ipcRenderer.send("win:minimize"),
  maximize: () => ipcRenderer.send("win:maximize"),
  close: () => ipcRenderer.send("win:close"),
  onMaximized: (cb) => ipcRenderer.on("win:maximized", cb),
  onUnmaximized: (cb) => ipcRenderer.on("win:unmaximized", cb),
  torSetMode: (mode) => ipcRenderer.invoke("tor:set-mode", mode),
  torGetStatus: () => ipcRenderer.invoke("tor:get-status"),
  onTorStatus: (cb) => ipcRenderer.on("tor:status-changed", (_e, data) => cb(data)),
  saveFile: (fileName, buffer) => ipcRenderer.invoke("file:save", fileName, buffer),
});

// Scoped IPC bridge for Service Worker ↔ Main process fetch proxy (Tor transport)
contextBridge.exposeInMainWorld("fetchBridge", {
  send: (channel, ...args) => {
    if (typeof channel === 'string' && channel.startsWith('FetchBridge:'))
      ipcRenderer.send(channel, ...args);
  },
  on: (channel, cb) => {
    if (typeof channel === 'string' && channel.startsWith('FetchBridge:'))
      ipcRenderer.on(channel, (_e, ...args) => cb(null, ...args));
  },
  invoke: (channel, ...args) => {
    if (channel === 'AltTransportActive')
      return ipcRenderer.invoke(channel, ...args);
  },
});
