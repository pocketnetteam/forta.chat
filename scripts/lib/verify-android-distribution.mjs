/**
 * Pure helpers for Android sideload/play distribution checks.
 */

import fs from "node:fs";
import path from "node:path";

export const INSTALL_PERMISSION = "android.permission.REQUEST_INSTALL_PACKAGES";

/**
 * @param {string} dir
 * @param {string} fileName
 * @returns {string[]}
 */
export function findFilesNamed(dir, fileName) {
  /** @type {string[]} */
  const found = [];
  if (!fs.existsSync(dir)) return found;

  /** @param {string} current */
  function walk(current) {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name === fileName) {
        found.push(full);
      }
    }
  }
  walk(dir);
  return found;
}

/**
 * @param {string[]} paths
 * @param {RegExp} pathHint
 * @returns {string | null}
 */
export function pickPathMatching(paths, pathHint) {
  const match = paths.find((p) => pathHint.test(p.replace(/\\/g, "/")));
  return match ?? null;
}

/**
 * @param {string} manifestXml
 * @param {boolean} expectPresent
 * @returns {{ ok: boolean, message: string }}
 */
export function assertInstallPermission(manifestXml, expectPresent) {
  const present = manifestXml.includes(INSTALL_PERMISSION);
  if (expectPresent && !present) {
    return {
      ok: false,
      message: `Expected ${INSTALL_PERMISSION} in sideload manifest`,
    };
  }
  if (!expectPresent && present) {
    return {
      ok: false,
      message: `Did not expect ${INSTALL_PERMISSION} in play manifest`,
    };
  }
  return {
    ok: true,
    message: expectPresent
      ? `sideload manifest keeps ${INSTALL_PERMISSION}`
      : `play manifest has no ${INSTALL_PERMISSION}`,
  };
}

/**
 * @param {string} buildConfigSource
 * @param {boolean} expectEnabled
 * @returns {{ ok: boolean, message: string }}
 */
export function assertEnableAppUpdater(buildConfigSource, expectEnabled) {
  const match = buildConfigSource.match(
    /ENABLE_APP_UPDATER\s*=\s*(true|false)/,
  );
  if (!match) {
    return { ok: false, message: "ENABLE_APP_UPDATER not found in BuildConfig" };
  }
  const actual = match[1] === "true";
  if (actual !== expectEnabled) {
    return {
      ok: false,
      message: `ENABLE_APP_UPDATER=${actual}, expected ${expectEnabled}`,
    };
  }
  return {
    ok: true,
    message: `ENABLE_APP_UPDATER=${actual}`,
  };
}

/**
 * @param {string} filePathsXml
 * @returns {{ ok: boolean, message: string }}
 */
export function assertApkUpdateFilePath(filePathsXml) {
  const hasName = filePathsXml.includes('name="apk_updates"');
  const hasPath = filePathsXml.includes('path="updates/"');
  if (!hasName || !hasPath) {
    return {
      ok: false,
      message: "file_paths.xml missing apk_updates / updates/ path",
    };
  }
  return { ok: true, message: "file_paths.xml keeps apk_updates path" };
}

/**
 * @param {string} root
 * @returns {{ ok: boolean, messages: string[] }}
 */
export function verifyAndroidDistribution(root) {
  const app = path.join(root, "android", "app");
  const intermediates = path.join(app, "build", "intermediates");
  const generated = path.join(app, "build", "generated");
  /** @type {string[]} */
  const messages = [];
  /** @type {string[]} */
  const errors = [];

  const manifests = findFilesNamed(intermediates, "AndroidManifest.xml");
  const sideloadManifest = pickPathMatching(
    manifests,
    /merged_manifests\/sideloadRelease\//,
  );
  const playManifest = pickPathMatching(
    manifests,
    /merged_manifests\/playRelease\//,
  );

  if (!sideloadManifest) {
    errors.push(
      "Missing merged sideloadRelease AndroidManifest.xml — run assembleSideloadRelease first",
    );
  } else {
    const xml = fs.readFileSync(sideloadManifest, "utf8");
    const result = assertInstallPermission(xml, true);
    (result.ok ? messages : errors).push(result.message);
  }

  if (!playManifest) {
    errors.push(
      "Missing merged playRelease AndroidManifest.xml — run bundlePlayRelease first",
    );
  } else {
    const xml = fs.readFileSync(playManifest, "utf8");
    const result = assertInstallPermission(xml, false);
    (result.ok ? messages : errors).push(result.message);
  }

  const allConfigs = [
    ...findFilesNamed(intermediates, "BuildConfig.java"),
    ...findFilesNamed(generated, "BuildConfig.java"),
  ];

  const sideloadConfig = pickPathMatching(
    allConfigs,
    /(?:sideloadRelease|sideload\/release)\//,
  );
  const playConfig = pickPathMatching(
    allConfigs,
    /(?:playRelease|play\/release)\//,
  );

  if (!sideloadConfig) {
    errors.push("Missing sideload BuildConfig.java with ENABLE_APP_UPDATER");
  } else {
    const src = fs.readFileSync(sideloadConfig, "utf8");
    const result = assertEnableAppUpdater(src, true);
    (result.ok ? messages : errors).push(`sideload: ${result.message}`);
  }

  if (!playConfig) {
    errors.push("Missing play BuildConfig.java with ENABLE_APP_UPDATER");
  } else {
    const src = fs.readFileSync(playConfig, "utf8");
    const result = assertEnableAppUpdater(src, false);
    (result.ok ? messages : errors).push(`play: ${result.message}`);
  }

  const filePaths = path.join(
    app,
    "src",
    "main",
    "res",
    "xml",
    "file_paths.xml",
  );
  if (!fs.existsSync(filePaths)) {
    errors.push("Missing android/app/src/main/res/xml/file_paths.xml");
  } else {
    const xml = fs.readFileSync(filePaths, "utf8");
    const result = assertApkUpdateFilePath(xml);
    (result.ok ? messages : errors).push(result.message);
  }

  const sideloadApkDir = path.join(
    app,
    "build",
    "outputs",
    "apk",
    "sideload",
    "release",
  );
  const sideloadApkCandidates = [
    path.join(sideloadApkDir, "app-sideload-release.apk"),
    path.join(sideloadApkDir, "app-sideload-release-unsigned.apk"),
  ];
  const playAab = path.join(
    app,
    "build",
    "outputs",
    "bundle",
    "playRelease",
    "app-play-release.aab",
  );

  const sideloadApk = sideloadApkCandidates.find((p) => fs.existsSync(p));
  if (!sideloadApk) {
    errors.push(
      `Missing sideload APK (expected app-sideload-release.apk or -unsigned.apk in ${sideloadApkDir})`,
    );
  } else {
    messages.push(`sideload APK artifact present (${path.basename(sideloadApk)})`);
  }

  if (!fs.existsSync(playAab)) {
    errors.push(`Missing play AAB: ${playAab}`);
  } else {
    messages.push("play AAB artifact present");
  }

  return {
    ok: errors.length === 0,
    messages: [...messages, ...errors.map((e) => `FAIL: ${e}`)],
  };
}
