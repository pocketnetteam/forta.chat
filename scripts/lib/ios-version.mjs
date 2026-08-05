/**
 * iOS Xcode version helpers — same semver → build number scheme as Android:
 * CURRENT_PROJECT_VERSION = major * 10000 + minor * 100 + patch
 * MARKETING_VERSION = "major.minor.patch"
 */

/**
 * @param {string} content
 * @param {string} versionName
 * @param {number} versionCode
 * @returns {boolean}
 */
function xcodeProjectHasVersion(content, versionName, versionCode) {
  const codeRe = new RegExp(`CURRENT_PROJECT_VERSION = ${versionCode};`);
  const nameRe = new RegExp(
    `MARKETING_VERSION = ${versionName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")};`,
  );
  return codeRe.test(content) && nameRe.test(content);
}

/**
 * Patch MARKETING_VERSION / CURRENT_PROJECT_VERSION in an Xcode project.pbxproj.
 * Idempotent when values already match.
 *
 * @param {string} content
 * @param {string} versionName
 * @param {number} versionCode
 * @returns {string}
 */
export function patchXcodeProject(content, versionName, versionCode) {
  if (xcodeProjectHasVersion(content, versionName, versionCode)) {
    return content;
  }

  const updated = content
    .replace(/CURRENT_PROJECT_VERSION = [^;]+;/g, `CURRENT_PROJECT_VERSION = ${versionCode};`)
    .replace(/MARKETING_VERSION = [^;]+;/g, `MARKETING_VERSION = ${versionName};`);

  if (updated === content || !xcodeProjectHasVersion(updated, versionName, versionCode)) {
    throw new Error("project.pbxproj version fields were not updated");
  }

  return updated;
}
