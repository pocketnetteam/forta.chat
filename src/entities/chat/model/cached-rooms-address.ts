const ACTIVE_ACCOUNT_KEY = "forta-chat:activeAccount";
const LEGACY_AUTH_KEY = "forta-chat:auth";

/**
 * Resolve the cached user address used by `loadCachedRooms` to open Dexie
 * before the full auth/Matrix flow runs (instant sidebar first-paint).
 *
 * WEE-61 / forta-bugs#892: after the multi-account migration the singleton
 * `forta-chat:auth` key is removed (`SessionManager.migrate`) and the address
 * lives under `forta-chat:activeAccount` as a JSON string. Reading the dead
 * `forta-chat:auth` key always returned null → empty sidebar until PREPARED.
 *
 * We read `activeAccount` first and fall back to the legacy key so the cache
 * paints regardless of migration timing (e.g. loadCachedRooms running before
 * `migrate()`).
 */
export function resolveCachedRoomsAddress(): string | null {
  try {
    const active = localStorage.getItem(ACTIVE_ACCOUNT_KEY);
    if (active) {
      const parsed: unknown = JSON.parse(active);
      if (typeof parsed === "string" && parsed) return parsed;
    }
  } catch {
    // malformed activeAccount — fall through to legacy key
  }

  try {
    const legacy = localStorage.getItem(LEGACY_AUTH_KEY);
    if (legacy) {
      const addr: unknown = (JSON.parse(legacy) as { address?: unknown })?.address;
      if (typeof addr === "string" && addr) return addr;
    }
  } catch {
    // malformed legacy auth — give up
  }

  return null;
}
