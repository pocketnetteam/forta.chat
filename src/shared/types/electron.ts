/**
 * Typed contract for Electron preload (`electron/preload.cjs`).
 * Keep in sync with contextBridge.exposeInMainWorld("electronAPI" / "fetchBridge").
 */

export type ElectronTorMode = "auto" | "always" | "neveruse";

export type ElectronTorStatus =
  | "stopped"
  | "running"
  | "install"
  | "started"
  | "failed";

export interface ElectronTorStatusPayload {
  status: ElectronTorStatus;
  info: string;
}

export interface ElectronTorStatusResult extends ElectronTorStatusPayload {
  mode?: ElectronTorMode;
  useSnowFlake2?: boolean;
}

export interface ElectronTorConfigureOpts {
  mode: ElectronTorMode;
  useSnowFlake2?: boolean;
}

export interface ElectronTorConfigureResult extends ElectronTorStatusPayload {
  mode: ElectronTorMode;
  useSnowFlake2?: boolean;
}

/** Desktop UX prefs owned by the main process (userData JSON). */
export interface ElectronDesktopSettings {
  /** Hide window on close instead of quitting (tray Quit still exits). */
  closeToTray: boolean;
  /** Launch Forta Chat when the OS user logs in. */
  openAtLogin: boolean;
}

/** Shape exposed as `window.electronAPI` from preload. */
export interface ElectronAPI {
  isElectron: true;
  platform: NodeJS.Platform;
  minimize: () => void;
  maximize: () => void;
  close: () => void;
  /** Focus / show the main window (e.g. notification click). */
  show: () => void;
  onMaximized: (cb: () => void) => void;
  onUnmaximized: (cb: () => void) => void;
  torSetMode: (mode: ElectronTorMode) => Promise<ElectronTorStatusResult>;
  torConfigure: (
    opts: ElectronTorConfigureOpts,
  ) => Promise<ElectronTorConfigureResult>;
  torGetStatus: () => Promise<ElectronTorStatusResult | null>;
  onTorStatus: (cb: (data: ElectronTorStatusPayload) => void) => void;
  saveFile: (
    fileName: string,
    buffer: ArrayBuffer,
  ) => Promise<string | null>;
  getDesktopSettings: () => Promise<ElectronDesktopSettings>;
  setDesktopSettings: (
    patch: Partial<ElectronDesktopSettings>,
  ) => Promise<ElectronDesktopSettings>;
  setBadgeCount: (count: number) => Promise<void>;
  setZoomFactor: (factor: number) => Promise<number>;
  getZoomFactor: () => Promise<number>;
  /** Subscribe to forta:// / https://forta.chat deep links from main. */
  onDeepLink: (cb: (url: string) => void) => () => void;
}

/** SW ↔ Main fetch proxy bridge (`window.fetchBridge`). */
export interface FetchBridge {
  send: (channel: string, ...args: unknown[]) => void;
  on: (
    channel: string,
    cb: (err: unknown, ...args: unknown[]) => void,
  ) => void;
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
    fetchBridge?: FetchBridge;
  }
}
