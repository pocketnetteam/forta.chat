/**
 * Tor stack orchestrator — wires TorControl, Transports, and FetchHandler
 * together and exposes IPC helpers for the renderer / main process.
 */

const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const TorControl = require('./tor-control.cjs');
const Transports = require('./transports.cjs');
const FetchHandler = require('./fetch-handler.cjs');
const {
  parseTorSettingsJson,
  serializeTorSettings,
} = require('./settings-persist.cjs');

function settingsFilePath() {
  return path.join(app.getPath('userData'), 'tor-settings.json');
}

/**
 * @returns {{ enabled3: string, useSnowFlake2: boolean } | null}
 */
function loadTorSettings() {
  try {
    const file = settingsFilePath();
    if (!fs.existsSync(file)) return null;
    return parseTorSettingsJson(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.warn('[Tor] Failed to load tor-settings.json:', e.message);
    return null;
  }
}

/**
 * @param {{ enabled3?: string, useSnowFlake2?: boolean }} settings
 */
function saveTorSettings(settings) {
  try {
    fs.writeFileSync(settingsFilePath(), serializeTorSettings(settings), 'utf8');
  } catch (e) {
    console.warn('[Tor] Failed to save tor-settings.json:', e.message);
  }
}

function hasPersistedTorSettings() {
  try {
    return fs.existsSync(settingsFilePath());
  } catch {
    return false;
  }
}

function initTor(ipcMain) {
  const persisted = loadTorSettings();
  const torControl = new TorControl({
    path: path.join(app.getPath('userData'), 'tor'),
    // Opt-in default (neveruse). Persisted file wins when present.
    enabled3: persisted?.enabled3 ?? 'neveruse',
    useSnowFlake2: persisted?.useSnowFlake2 ?? false,
  });

  const transports = new Transports(torControl);

  FetchHandler.init(ipcMain, {
    fetchFunction: (...args) => transports.fetch(...args),
  });

  ipcMain.handle('AltTransportActive', async (_event, url) => {
    return transports.isTorNeeded(url);
  });

  torControl.init();

  return { transports, torControl };
}

module.exports = {
  initTor,
  loadTorSettings,
  saveTorSettings,
  hasPersistedTorSettings,
};
