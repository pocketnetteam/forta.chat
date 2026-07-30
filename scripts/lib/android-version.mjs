/**
 * Shared Android semver helpers (prod + test APK CI).
 *
 * versionCode = major * 10000 + minor * 100 + patch
 */

/**
 * @param {string} version
 * @returns {{ major: number; minor: number; patch: number } | null}
 */
export function parseSemver(version) {
  const match = String(version).trim().match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) {
    return null;
  }

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

/**
 * @param {{ major: number; minor: number; patch: number }} parts
 * @returns {string}
 */
export function formatSemver(parts) {
  return `${parts.major}.${parts.minor}.${parts.patch}`;
}

/**
 * @param {{ major: number; minor: number; patch: number }} parts
 * @returns {number}
 */
export function versionCodeFromSemver(parts) {
  return parts.major * 10_000 + parts.minor * 100 + parts.patch;
}

/**
 * @param {string} version
 * @returns {number}
 */
export function versionCodeFromVersionString(version) {
  const parts = parseSemver(version);
  if (!parts) {
    throw new Error(`Invalid semver: ${version}`);
  }
  return versionCodeFromSemver(parts);
}

/**
 * @param {{ major: number; minor: number; patch: number }} parts
 * @returns {{ major: number; minor: number; patch: number }}
 */
export function bumpPatch(parts) {
  return { ...parts, patch: parts.patch + 1 };
}

/**
 * @param {string} a
 * @param {string} b
 * @returns {number} negative if a < b, positive if a > b, 0 if equal
 */
export function compareSemverStrings(a, b) {
  const left = parseSemver(a);
  const right = parseSemver(b);
  if (!left || !right) {
    throw new Error(`Cannot compare versions: ${a} vs ${b}`);
  }

  if (left.major !== right.major) {
    return left.major - right.major;
  }
  if (left.minor !== right.minor) {
    return left.minor - right.minor;
  }
  return left.patch - right.patch;
}

/**
 * Pick the highest semver string from a list.
 * @param {string[]} versions
 * @returns {string}
 */
export function maxSemverString(versions) {
  const valid = versions.filter((v) => parseSemver(v));
  if (valid.length === 0) {
    throw new Error("No valid semver versions provided");
  }

  return valid.reduce((max, current) =>
    compareSemverStrings(current, max) > 0 ? current : max,
  );
}

/**
 * Next release version: max(base versions) + 1 patch.
 * @param {string[]} baseVersions
 * @returns {{ versionName: string; versionCode: number }}
 */
export function resolveNextAndroidVersion(baseVersions) {
  const maxVersion = maxSemverString(baseVersions);
  const parts = parseSemver(maxVersion);
  if (!parts) {
    throw new Error(`Invalid base version: ${maxVersion}`);
  }

  const next = bumpPatch(parts);
  const versionName = formatSemver(next);

  return {
    versionName,
    versionCode: versionCodeFromSemver(next),
  };
}

/**
 * @param {string} content
 * @param {string} versionName
 * @param {number} versionCode
 * @returns {boolean}
 */
function buildGradleHasVersion(content, versionName, versionCode) {
  const codeRe = new RegExp(`versionCode\\s+${versionCode}\\b`);
  const nameRe = new RegExp(`versionName\\s+"${versionName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`);
  return codeRe.test(content) && nameRe.test(content);
}

/**
 * @param {string} content
 * @param {string} versionName
 * @param {number} versionCode
 * @returns {string}
 */
export function patchBuildGradle(content, versionName, versionCode) {
  // Idempotent: CI may re-run inject when build.gradle already has the
  // resolved version (e.g. committed locally for a Play re-upload).
  if (buildGradleHasVersion(content, versionName, versionCode)) {
    return content;
  }

  const updated = content
    .replace(/versionCode \d+/, `versionCode ${versionCode}`)
    .replace(/versionName "[^"]*"/, `versionName "${versionName}"`);

  if (updated === content || !buildGradleHasVersion(updated, versionName, versionCode)) {
    throw new Error("build.gradle version fields were not updated");
  }

  return updated;
}
