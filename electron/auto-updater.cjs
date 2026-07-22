/**
 * electron-updater wiring for Forta Chat desktop.
 * Skips checks in Vite/dev and when FORTA_DISABLE_AUTO_UPDATE=1.
 * Events are forwarded to the renderer via IPC (update:*).
 */

/** @typedef {"idle" | "checking" | "available" | "not-available" | "downloading" | "downloaded" | "error"} UpdateStatus */

/**
 * @typedef {object} UpdateState
 * @property {UpdateStatus} status
 * @property {string | null} version
 * @property {number | null} percent
 * @property {string | null} error
 * @property {boolean} enabled
 */

/**
 * @param {Partial<UpdateState>} [patch]
 * @returns {UpdateState}
 */
function createUpdateState(patch = {}) {
  return {
    status: "idle",
    version: null,
    percent: null,
    error: null,
    enabled: false,
    ...patch,
  };
}

/**
 * Normalize electron-updater UpdateInfo / ProgressInfo for IPC.
 * @param {{ version?: string } | undefined | null} info
 * @returns {{ version: string | null }}
 */
function mapUpdateInfo(info) {
  const version =
    info && typeof info.version === "string" && info.version.length > 0
      ? info.version
      : null;
  return { version };
}

/**
 * @param {{ percent?: number } | undefined | null} progress
 * @returns {{ percent: number }}
 */
function mapProgress(progress) {
  const raw = progress && typeof progress.percent === "number" ? progress.percent : 0;
  const percent = Math.min(100, Math.max(0, Math.round(raw * 10) / 10));
  return { percent };
}

/** Lazy-load so unit tests can import helpers without Electron runtime. */
function getAutoUpdater() {
  return require("electron-updater").autoUpdater;
}

/**
 * @param {{
 *   BrowserWindow: typeof import("electron").BrowserWindow,
 *   ipcMain: import("electron").IpcMain,
 *   isDev: boolean,
 *   prepareForQuit?: () => void,
 *   checkDelayMs?: number,
 * }} opts
 * @returns {{ enabled: boolean, getState: () => UpdateState, dispose: () => void }}
 */
function initAutoUpdater(opts) {
  const {
    BrowserWindow,
    ipcMain,
    isDev,
    prepareForQuit,
    checkDelayMs = 8_000,
  } = opts;

  const disabledByEnv = process.env.FORTA_DISABLE_AUTO_UPDATE === "1";
  const enabled = !isDev && !disabledByEnv;

  /** @type {UpdateState} */
  let state = createUpdateState({ enabled });

  /** @param {string} channel @param {unknown} [payload] */
  function broadcast(channel, payload) {
    const wins = BrowserWindow.getAllWindows();
    for (const win of wins) {
      if (!win.isDestroyed()) win.webContents.send(channel, payload);
    }
  }

  /** @param {Partial<UpdateState>} patch @param {string} channel */
  function setState(patch, channel) {
    state = { ...state, ...patch, enabled };
    broadcast(channel, { ...state });
  }

  ipcMain.handle("update:get-status", () => ({ ...state }));

  ipcMain.handle("update:check", async () => {
    if (!enabled) {
      return { ...state, status: "idle", error: "auto-update disabled" };
    }
    try {
      await getAutoUpdater().checkForUpdates();
      return { ...state };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setState(
        { status: "error", error: message, percent: null },
        "update:error",
      );
      return { ...state };
    }
  });

  ipcMain.handle("update:quit-and-install", () => {
    if (!enabled || state.status !== "downloaded") return false;
    // Bypass close-to-tray so the updater can replace files and relaunch.
    if (typeof prepareForQuit === "function") prepareForQuit();
    setImmediate(() => {
      getAutoUpdater().quitAndInstall(false, true);
    });
    return true;
  });

  if (!enabled) {
    return {
      enabled: false,
      getState: () => ({ ...state }),
      dispose: () => undefined,
    };
  }

  const autoUpdater = getAutoUpdater();
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  const onChecking = () => {
    setState(
      { status: "checking", error: null, percent: null, version: null },
      "update:checking",
    );
  };
  const onAvailable = (info) => {
    const { version } = mapUpdateInfo(info);
    setState(
      { status: "available", version, error: null, percent: 0 },
      "update:available",
    );
  };
  const onNotAvailable = (info) => {
    const { version } = mapUpdateInfo(info);
    setState(
      { status: "not-available", version, error: null, percent: null },
      "update:not-available",
    );
  };
  const onProgress = (progress) => {
    const { percent } = mapProgress(progress);
    setState({ status: "downloading", percent, error: null }, "update:progress");
  };
  const onDownloaded = (info) => {
    const { version } = mapUpdateInfo(info);
    setState(
      { status: "downloaded", version, percent: 100, error: null },
      "update:downloaded",
    );
  };
  const onError = (err) => {
    const message = err instanceof Error ? err.message : String(err);
    setState(
      { status: "error", error: message, percent: null },
      "update:error",
    );
  };

  autoUpdater.on("checking-for-update", onChecking);
  autoUpdater.on("update-available", onAvailable);
  autoUpdater.on("update-not-available", onNotAvailable);
  autoUpdater.on("download-progress", onProgress);
  autoUpdater.on("update-downloaded", onDownloaded);
  autoUpdater.on("error", onError);

  const timer = setTimeout(() => {
    autoUpdater.checkForUpdatesAndNotify().catch((e) => {
      const message = e instanceof Error ? e.message : String(e);
      console.warn("[auto-updater] initial check failed:", message);
    });
  }, checkDelayMs);

  return {
    enabled: true,
    getState: () => ({ ...state }),
    dispose: () => {
      clearTimeout(timer);
      autoUpdater.removeListener("checking-for-update", onChecking);
      autoUpdater.removeListener("update-available", onAvailable);
      autoUpdater.removeListener("update-not-available", onNotAvailable);
      autoUpdater.removeListener("download-progress", onProgress);
      autoUpdater.removeListener("update-downloaded", onDownloaded);
      autoUpdater.removeListener("error", onError);
    },
  };
}

module.exports = {
  createUpdateState,
  mapUpdateInfo,
  mapProgress,
  initAutoUpdater,
};
