/**
 * Pure helpers for CI electron smoke boots (no Electron imports).
 */

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
function isElectronSmokeMode(env = process.env) {
  return env.FORTA_ELECTRON_SMOKE === "1";
}

/**
 * Tor mode override for boot. Smoke must not download/start Tor.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {"neveruse" | undefined}
 */
function resolveTorModeForBoot(env = process.env) {
  if (isElectronSmokeMode(env)) return "neveruse";
  return undefined;
}

module.exports = {
  isElectronSmokeMode,
  resolveTorModeForBoot,
};
