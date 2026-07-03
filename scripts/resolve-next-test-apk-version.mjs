#!/usr/bin/env node
/**
 * Prints the next test APK version for GitHub Actions ($GITHUB_OUTPUT).
 * Base: package.json version (+ deployed apktests/version.json if newer).
 */

import { appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveNextTestApkVersionFromSources } from "./lib/resolve-test-apk-version.mjs";

async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const packageJsonPath = path.join(root, "package.json");

  const { versionName, versionCode } = await resolveNextTestApkVersionFromSources({
    packageJsonPath,
  });

  const lines = [
    `version=${versionName}`,
    `version_code=${versionCode}`,
  ];

  const outputPath = process.env.GITHUB_OUTPUT;
  const payload = `${lines.join("\n")}\n`;

  if (outputPath) {
    appendFileSync(outputPath, payload, "utf8");
  } else {
    process.stdout.write(payload);
  }

  console.log(
    `[resolve-next-test-apk-version] next versionName=${versionName} versionCode=${versionCode}`,
  );
}

main().catch((error) => {
  console.error("[resolve-next-test-apk-version]", error);
  process.exit(1);
});
