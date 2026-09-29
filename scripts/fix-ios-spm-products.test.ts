import { describe, it, expect } from "vitest";
import { alignProducts, declaredLibrary, localPackages } from "./fix-ios-spm-products.mjs";

/**
 * `cap sync ios` names a plugin's SPM product after its npm name; the llama-cpp-pro
 * fork declares `LlamaCppCapacitor`, and Xcode 16.4 stopped at "product 'LlamaCppPro'
 * not found" (2026-09-23). The post-sync script renames the product to what the plugin
 * declares, and only that.
 */
const generated = `
        .package(name: "CapacitorApp", path: "../../../node_modules/@capacitor/app"),
        .package(name: "LlamaCppPro", path: "../../../node_modules/llama-cpp-pro")
    ],
    targets: [
        .target(
            name: "CapApp-SPM",
            dependencies: [
                .product(name: "CapacitorApp", package: "CapacitorApp"),
                .product(name: "LlamaCppPro", package: "LlamaCppPro")
`;
const plugins: Record<string, string> = {
  "../../../node_modules/@capacitor/app": 'products: [ .library(name: "CapacitorApp", targets: ["AppPlugin"]) ]',
  "../../../node_modules/llama-cpp-pro": 'products: [\n        .library(\n            name: "LlamaCppCapacitor",\n            targets: ["LlamaCppCapacitor"])',
};

describe("fix-ios-spm-products", () => {
  it("lists the local packages of the generated manifest", () => {
    expect(localPackages(generated).map((p) => p.name)).toEqual(["CapacitorApp", "LlamaCppPro"]);
  });

  it("reads the library a plugin declares, across line breaks", () => {
    expect(declaredLibrary(plugins["../../../node_modules/llama-cpp-pro"])).toBe("LlamaCppCapacitor");
    expect(declaredLibrary("no products here")).toBeNull();
  });

  it("renames only the product whose name differs from the declared library", () => {
    const { manifest, changes } = alignProducts(generated, (p) => plugins[p] ?? null);
    expect(changes).toEqual([{ package: "LlamaCppPro", product: "LlamaCppCapacitor" }]);
    expect(manifest).toContain('.product(name: "LlamaCppCapacitor", package: "LlamaCppPro")');
    expect(manifest).toContain('.product(name: "CapacitorApp", package: "CapacitorApp")');
    expect(manifest).toContain('.package(name: "LlamaCppPro", path:');
  });

  it("is idempotent and leaves a manifest alone when every plugin is missing", () => {
    const once = alignProducts(generated, (p) => plugins[p] ?? null).manifest;
    expect(alignProducts(once, (p) => plugins[p] ?? null)).toEqual({ manifest: once, changes: [] });
    expect(alignProducts(generated, () => null)).toEqual({ manifest: generated, changes: [] });
  });
});
