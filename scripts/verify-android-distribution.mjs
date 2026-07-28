#!/usr/bin/env node
/**
 * Post-build checks for Android distribution flavors:
 * - sideload: keeps REQUEST_INSTALL_PACKAGES + ENABLE_APP_UPDATER=true
 * - play: strips REQUEST_INSTALL_PACKAGES + ENABLE_APP_UPDATER=false
 *
 * Reads Gradle intermediates (merged manifests + BuildConfig) so it works
 * without aapt/bundletool after `assembleSideloadRelease bundlePlayRelease`.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyAndroidDistribution } from "./lib/verify-android-distribution.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const result = verifyAndroidDistribution(ROOT);
  for (const line of result.messages) {
    console.log(line.startsWith("FAIL:") ? line : `OK: ${line}`);
  }
  if (!result.ok) {
    process.exit(1);
  }
  console.log("Android distribution verification passed.");
}
