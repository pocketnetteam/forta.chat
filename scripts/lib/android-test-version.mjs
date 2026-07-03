/**
 * Pure helpers for CI test APK versioning.
 *
 * versionName: test-<shortSha>
 * versionCode: 900000 + runNumber
 */

const TEST_VERSION_CODE_BASE = 900_000;
const SHORT_SHA_LENGTH = 7;

/**
 * @param {string} shortSha
 * @returns {string}
 */
export function computeTestVersionName(shortSha) {
  const normalized = shortSha.trim().slice(0, SHORT_SHA_LENGTH);
  if (!/^[0-9a-fA-F]+$/.test(normalized)) {
    throw new Error(`Invalid git sha for test version: ${shortSha}`);
  }
  return `test-${normalized.toLowerCase()}`;
}

/**
 * @param {number | string} runNumber
 * @returns {number}
 */
export function computeTestVersionCode(runNumber) {
  const n = Number(runNumber);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`Invalid run number: ${runNumber}`);
  }
  return TEST_VERSION_CODE_BASE + n;
}

/**
 * @param {string} content
 * @param {string} versionName
 * @param {number} versionCode
 * @returns {string}
 */
export function patchBuildGradle(content, versionName, versionCode) {
  const updated = content
    .replace(/versionCode \d+/, `versionCode ${versionCode}`)
    .replace(/versionName "[^"]*"/, `versionName "${versionName}"`);

  if (updated === content) {
    throw new Error("build.gradle version fields were not updated");
  }

  return updated;
}
