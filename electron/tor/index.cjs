/**
 * Tor stack orchestrator — wires TorControl, Transports, and FetchHandler
 * together and exposes IPC handlers for the renderer.
 */

const path = require('path');
const { app } = require('electron');
const TorControl = require('./tor-control.cjs');
const Transports = require('./transports.cjs');
const FetchHandler = require('./fetch-handler.cjs');

// Snowflake bridges — disabled by default.
// Only useful in countries that actively block Tor (Iran, Russia).
// When enabled, Tor CANNOT connect without available Snowflake proxies,
// so we default to direct connection and let users opt-in to bridges later.
function shouldUseSnowflake() {
  return false;
}

/**
 * @param {import('electron').IpcMain} ipcMain
 * @param {{ enabled3?: 'neveruse' | 'auto' | 'always' }} [options]
 */
function initTor(ipcMain, options = {}) {
  const torControl = new TorControl({
    path: path.join(app.getPath('userData'), 'tor'),
    enabled3: options.enabled3 ?? 'auto',
    useSnowFlake2: shouldUseSnowflake(),
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

module.exports = { initTor };
