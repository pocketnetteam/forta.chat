/**
 * Pure helpers for Electron Tor settings persistence (no Electron imports).
 * Used by electron/tor/index.cjs and unit tests.
 */

/**
 * @param {unknown} raw
 * @returns {{ enabled3: 'auto' | 'always' | 'neveruse', useSnowFlake2: boolean } | null}
 */
function normalizeTorSettings(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const obj = /** @type {Record<string, unknown>} */ (raw);
  const enabled3 =
    obj.enabled3 === 'auto' || obj.enabled3 === 'always' || obj.enabled3 === 'neveruse'
      ? obj.enabled3
      : null;
  if (!enabled3) return null;
  return {
    enabled3,
    useSnowFlake2: !!obj.useSnowFlake2,
  };
}

/**
 * @param {string} text
 * @returns {{ enabled3: 'auto' | 'always' | 'neveruse', useSnowFlake2: boolean } | null}
 */
function parseTorSettingsJson(text) {
  try {
    return normalizeTorSettings(JSON.parse(text));
  } catch {
    return null;
  }
}

/**
 * @param {{ enabled3?: string, useSnowFlake2?: boolean }} settings
 * @returns {string}
 */
function serializeTorSettings(settings) {
  const enabled3 =
    settings.enabled3 === 'auto' || settings.enabled3 === 'always' || settings.enabled3 === 'neveruse'
      ? settings.enabled3
      : 'neveruse';
  return JSON.stringify(
    {
      enabled3,
      useSnowFlake2: !!settings.useSnowFlake2,
    },
    null,
    2,
  );
}

module.exports = {
  normalizeTorSettings,
  parseTorSettingsJson,
  serializeTorSettings,
};
