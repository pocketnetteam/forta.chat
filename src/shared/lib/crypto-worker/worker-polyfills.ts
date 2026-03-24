/**
 * Polyfills for Web Worker environment.
 * Must be the FIRST import in crypto.worker.ts — ES modules evaluate
 * side-effect imports in declaration order, so this runs before pbkdf2/etc.
 */

// Node.js packages reference `global` which doesn't exist in Web Workers
if (typeof (globalThis as Record<string, unknown>).global === "undefined") {
  (globalThis as Record<string, unknown>).global = globalThis;
}

// miscreant references `window.crypto` for WebCrypto API
if (typeof (globalThis as Record<string, unknown>).window === "undefined") {
  (globalThis as Record<string, unknown>).window = globalThis;
}

// Some packages check for `process`
if (typeof (globalThis as Record<string, unknown>).process === "undefined") {
  (globalThis as Record<string, unknown>).process = { browser: true, env: {} } as unknown;
}
