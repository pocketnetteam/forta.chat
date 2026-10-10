import { describe, expect, it } from "vitest";
import { manualChunks } from "./lib/vite-manual-chunks.mjs";

describe("manualChunks", () => {
  it("keeps the Rust crypto WASM out of the eagerly preloaded matrix chunk", () => {
    expect(
      manualChunks("C:/app/node_modules/@matrix-org/matrix-sdk-crypto-wasm/pkg/matrix_sdk_crypto_wasm_bg.wasm.js"),
    ).toBeUndefined();
    expect(manualChunks("/app/node_modules/@matrix-org/matrix-sdk-crypto-wasm/pkg/index.js")).toBeUndefined();
  });

  it("keeps the SDK rust-crypto wrapper lazy on both path separators", () => {
    expect(manualChunks("/app/node_modules/matrix-js-sdk-bastyon/lib/rust-crypto/index.js")).toBeUndefined();
    expect(manualChunks("C:\\app\\node_modules\\matrix-js-sdk-bastyon\\lib\\rust-crypto\\rust-crypto.js")).toBeUndefined();
  });

  it("still groups the rest of the SDK into the matrix chunk", () => {
    expect(manualChunks("/app/node_modules/matrix-js-sdk-bastyon/lib/client.js")).toBe("matrix");
    expect(manualChunks("/app/node_modules/@matrix-org/olm/olm.js")).toBe("matrix");
  });

  it("keeps the other vendor groups", () => {
    expect(manualChunks("/app/node_modules/vue-router/dist/vue-router.mjs")).toBe("vue-core");
    expect(manualChunks("/app/node_modules/buffer/index.js")).toBe("crypto-polyfills");
    expect(manualChunks("/app/src/main.ts")).toBeUndefined();
  });
});
