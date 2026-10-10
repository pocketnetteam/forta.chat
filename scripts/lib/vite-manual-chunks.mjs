/**
 * Rollup manualChunks for the Vite build.
 *
 * The Rust crypto WASM (@matrix-org/matrix-sdk-crypto-wasm, ~8.6 MB as a base64
 * string) and the SDK's rust-crypto wrapper stay out of the "matrix" chunk. The
 * SDK reaches them only through `import("./rust-crypto")` in initRustCrypto(),
 * which we never call (E2E is Bastyon's own). Forcing them into "matrix" turned
 * that lazy import into a startup modulepreload of ~9.7 MB.
 *
 * @param {string} id
 * @returns {string | undefined}
 */
export function manualChunks(id) {
  if (id.includes("matrix-sdk-crypto-wasm") || /[\\/]rust-crypto[\\/]/.test(id)) return undefined;
  if (id.includes("matrix-js-sdk") || id.includes("@matrix-org")) return "matrix";
  if (id.includes("node_modules/vue") || id.includes("vue-router") || id.includes("pinia")) return "vue-core";
  if (id.includes("vue-virtual-scroller")) return "virtual-scroller";
  if (id.includes("node_modules/buffer") || id.includes("stream-browserify") || id.includes("pbkdf2") || id.includes("create-hash") || id.includes("bn.js")) return "crypto-polyfills";
  return undefined;
}
