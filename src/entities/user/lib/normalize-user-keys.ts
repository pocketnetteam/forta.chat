/**
 * Normalize Pocketnet profile key fields (`keys` array or comma-separated `k`)
 * into a clean string[]. Empty / non-string entries are dropped.
 */
export function normalizeUserKeys(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((k): k is string => typeof k === "string" && !!k);
  }
  if (typeof value === "string" && value) {
    return value.split(",").filter((k) => k);
  }
  return [];
}
