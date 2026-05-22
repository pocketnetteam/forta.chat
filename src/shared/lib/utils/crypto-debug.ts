/**
 * Opt-in diagnostic logging for cross-client encryption debugging (WEE-39).
 *
 * Activated by setting `localStorage["debug:crypto"] = "1"` in DevTools.
 * Off by default in production — no log spam unless explicitly enabled.
 *
 * Logs are structural only (counts, flags, hashes) — they MUST NOT contain
 * keys, plaintext, or any field that could leak ciphertext content.
 */

let cachedFlag: boolean | null = null;

function readFlag(): boolean {
  if (cachedFlag !== null) return cachedFlag;
  try {
    if (typeof localStorage === "undefined") {
      cachedFlag = false;
      return false;
    }
    cachedFlag = localStorage.getItem("debug:crypto") === "1";
  } catch {
    cachedFlag = false;
  }
  return cachedFlag;
}

/**
 * Manually invalidate the cached flag (e.g. after toggling in DevTools).
 *
 * Scope caveat: this only resets the cache in the module instance that
 * imported it. Web Workers and the main thread each load their own copy
 * of the module, so toggling the flag at runtime requires either a worker
 * restart or a worker-side `postMessage` that forwards the reset.
 */
export function resetCryptoDebugCache(): void {
  cachedFlag = null;
}

/** True when crypto-debug logging is enabled via `localStorage["debug:crypto"]`. */
export function isCryptoDebugEnabled(): boolean {
  return readFlag();
}

/** Emit a tagged debug line. Safe to call unconditionally — no-op when flag off. */
export function cryptoDebug(tag: string, payload: Record<string, unknown>): void {
  if (!readFlag()) return;
  console.warn(`[crypto-debug:${tag}]`, payload);
}

/**
 * Detect whether a plaintext payload looks like it carries a Matrix-style
 * @mention. Used purely for diagnostic logs — not as part of the crypto path.
 */
export function looksLikeMention(text: string): boolean {
  if (!text || text.length < 2) return false;
  return /(^|\s)@\S/.test(text);
}
