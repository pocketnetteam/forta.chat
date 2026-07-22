import type { ElectronAPI, FetchBridge } from "@/shared/types/electron";

/** Preload-shaped ElectronAPI mock for unit tests. */
export function createElectronApiMock(
  overrides: Partial<ElectronAPI> = {},
): ElectronAPI {
  return {
    isElectron: true,
    platform: "win32",
    minimize: () => undefined,
    maximize: () => undefined,
    close: () => undefined,
    show: () => undefined,
    onMaximized: () => undefined,
    onUnmaximized: () => undefined,
    torSetMode: async () => ({ status: "stopped", info: "" }),
    torConfigure: async () => ({
      status: "stopped",
      info: "",
      mode: "neveruse",
    }),
    torGetStatus: async () => ({ status: "stopped", info: "" }),
    onTorStatus: () => undefined,
    saveFile: async () => null,
    getDesktopSettings: async () => ({
      closeToTray: true,
      openAtLogin: false,
    }),
    setDesktopSettings: async (patch) => ({
      closeToTray: patch.closeToTray ?? true,
      openAtLogin: patch.openAtLogin ?? false,
    }),
    setBadgeCount: async () => undefined,
    setZoomFactor: async (factor) => factor,
    getZoomFactor: async () => 1,
    onDeepLink: () => () => undefined,
    getUpdateStatus: async () => ({
      status: "idle",
      version: null,
      percent: null,
      error: null,
      enabled: false,
    }),
    checkForUpdates: async () => ({
      status: "idle",
      version: null,
      percent: null,
      error: null,
      enabled: false,
    }),
    quitAndInstallUpdate: async () => false,
    onUpdateStatus: () => () => undefined,
    ...overrides,
  };
}

/** Preload-shaped fetchBridge mock for unit tests. */
export function createFetchBridgeMock(
  overrides: Partial<FetchBridge> = {},
): FetchBridge {
  return {
    send: () => undefined,
    on: () => undefined,
    invoke: async () => false,
    ...overrides,
  };
}
