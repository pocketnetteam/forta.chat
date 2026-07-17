/**
 * Extract a human-readable message from an unknown thrown value.
 *
 * Wallet RPC failures (Pocketnet `api.rpc(...)`) can reject with arbitrary
 * shapes — plain objects like `{ code, message }` or `{ error: { message } }` —
 * which stringify to the useless `"[object Object]"`. This normalizes those
 * shapes into a readable string, falling back to a caller-provided message.
 */
export function extractErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error) {
    return err.message || fallback;
  }
  if (typeof err === "string") {
    return err || fallback;
  }
  if (err && typeof err === "object") {
    // Direct { message } shape
    if ("message" in err) {
      const msg = (err as { message: unknown }).message;
      if (typeof msg === "string" && msg) return msg;
    }
    // Nested Pocketnet RPC shape: { error: { message } } or { error: "..." }
    if ("error" in err) {
      const nested = (err as { error: unknown }).error;
      if (typeof nested === "string" && nested) return nested;
      if (nested && typeof nested === "object" && "message" in nested) {
        const msg = (nested as { message: unknown }).message;
        if (typeof msg === "string" && msg) return msg;
      }
    }
  }
  return fallback;
}
