#!/usr/bin/env node
/**
 * Align the SPM product names in ios/App/CapApp-SPM/Package.swift with what each
 * plugin's own Package.swift declares.
 *
 * `cap sync ios` names every plugin's product after its npm package name
 * (`fixName`: llama-cpp-pro → LlamaCppPro). The llama-cpp-pro fork declares its
 * library as `LlamaCppCapacitor`, so Xcode stopped at resolution:
 * "product 'LlamaCppPro' … not found in package 'LlamaCppPro'" (2026-09-23).
 * Capacitor offers no override, and the manifest is regenerated on every sync,
 * so this runs right after it. Pure: exported for the test, CLI when run directly.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** `.package(name: "X", path: "…")` entries of the generated manifest. */
export function localPackages(manifest) {
  return [...manifest.matchAll(/\.package\(name: "([^"]+)", path: "([^"]+)"\)/g)].map((m) => ({ name: m[1], path: m[2] }));
}

/** The first `.library(name: "…")` a plugin's Package.swift declares, or null. */
export function declaredLibrary(pluginManifest) {
  const m = pluginManifest.match(/\.library\(\s*name:\s*"([^"]+)"/);
  return m ? m[1] : null;
}

/** The manifest with every `.product(name: <package name>, package: <package name>)` renamed to the library the plugin declares. */
export function alignProducts(manifest, readPluginManifest) {
  let out = manifest;
  const changes = [];
  for (const { name, path } of localPackages(manifest)) {
    const plugin = readPluginManifest(path);
    if (!plugin) continue;
    const library = declaredLibrary(plugin);
    if (!library || library === name) continue;
    const from = `.product(name: "${name}", package: "${name}")`;
    const to = `.product(name: "${library}", package: "${name}")`;
    if (out.includes(from)) {
      out = out.split(from).join(to);
      changes.push({ package: name, product: library });
    }
  }
  return { manifest: out, changes };
}

const here = dirname(fileURLToPath(import.meta.url));
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const manifestPath = resolve(here, "../ios/App/CapApp-SPM/Package.swift");
  const manifest = readFileSync(manifestPath, "utf8");
  const { manifest: fixed, changes } = alignProducts(manifest, (p) => {
    const file = resolve(dirname(manifestPath), p, "Package.swift");
    return existsSync(file) ? readFileSync(file, "utf8") : null;
  });
  if (changes.length) {
    writeFileSync(manifestPath, fixed);
    for (const c of changes) console.log(`[ios-spm] ${c.package}: product → ${c.product}`);
  }
}
