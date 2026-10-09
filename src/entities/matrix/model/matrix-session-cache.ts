/**
 * Boot caches that let a page reload reach /sync without repeating work whose
 * answer rarely changes:
 *
 * - the Matrix session (access token + device) — skips POST /login;
 * - the live homeserver host — skips the /versions ping-and-pick (WEE-105),
 *   which only changes when regional blocking does;
 * - the uploaded /sync filter id — skips POST /filter.
 *
 * Session and host live for {@link MATRIX_BOOT_CACHE_TTL_MS} from the moment
 * they were proven (login, successful probe); the filter id is keyed by its
 * definition and dropped when the code changes it. A stale token is recovered:
 * the client re-logs in on 401 M_UNKNOWN_TOKEN (see matrix-client.ts).
 *
 * Key format mirrors device-id-storage.ts: `<prefix>:<address>`.
 */

export const MATRIX_BOOT_CACHE_TTL_MS = 3 * 24 * 60 * 60 * 1000;

const SESSION_PREFIX = "matrix_session";
const FILTER_PREFIX = "matrix_sync_filter";
const HOST_KEY = "matrix_live_host";

export interface CachedMatrixSession {
  userId: string;
  accessToken: string;
  deviceId: string;
  obtainedAt: number;
}

function readJson(key: string): Record<string, unknown> | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage full or blocked — the cache is an optimization only */
  }
}

function remove(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

const isFresh = (at: unknown, now: number): at is number =>
  typeof at === "number" && at <= now && now - at < MATRIX_BOOT_CACHE_TTL_MS;

const isNonEmptyString = (v: unknown): v is string => typeof v === "string" && v.length > 0;

/** Session obtained by login less than 3 days ago, or null. */
export function readCachedMatrixSession(address: string, now = Date.now()): CachedMatrixSession | null {
  if (!address) return null;
  const p = readJson(`${SESSION_PREFIX}:${address}`);
  if (!p || !isFresh(p.obtainedAt, now)) return null;
  if (!isNonEmptyString(p.userId) || !isNonEmptyString(p.accessToken) || !isNonEmptyString(p.deviceId)) {
    return null;
  }
  return { userId: p.userId, accessToken: p.accessToken, deviceId: p.deviceId, obtainedAt: p.obtainedAt };
}

/** Remember a session right after a successful login/register. */
export function writeCachedMatrixSession(
  address: string,
  session: { userId: string; accessToken: string; deviceId: string },
  now = Date.now(),
): void {
  if (!address || !session.userId || !session.accessToken || !session.deviceId) return;
  writeJson(`${SESSION_PREFIX}:${address}`, { ...session, obtainedAt: now });
}

export function clearCachedMatrixSession(address: string): void {
  if (!address) return;
  remove(`${SESSION_PREFIX}:${address}`);
}

/** Host that answered a probe less than 3 days ago, if it is still one of `allowed`. */
export function readCachedMatrixHost(allowed: readonly string[], now = Date.now()): string | null {
  const p = readJson(HOST_KEY);
  if (!p || !isFresh(p.checkedAt, now) || !isNonEmptyString(p.host)) return null;
  return allowed.includes(p.host) ? p.host : null;
}

export function writeCachedMatrixHost(host: string, now = Date.now()): void {
  if (!host) return;
  writeJson(HOST_KEY, { host, checkedAt: now });
}

export function clearCachedMatrixHost(): void {
  remove(HOST_KEY);
}

/** Server filter id uploaded for exactly this definition (compared as JSON). */
export function readCachedSyncFilterId(address: string, definition: unknown): string | null {
  if (!address) return null;
  const p = readJson(`${FILTER_PREFIX}:${address}`);
  if (!p || !isNonEmptyString(p.filterId)) return null;
  return p.definition === JSON.stringify(definition) ? p.filterId : null;
}

export function writeCachedSyncFilterId(address: string, definition: unknown, filterId: string): void {
  if (!address || !filterId) return;
  writeJson(`${FILTER_PREFIX}:${address}`, { filterId, definition: JSON.stringify(definition) });
}

export function clearCachedSyncFilterId(address: string): void {
  if (!address) return;
  remove(`${FILTER_PREFIX}:${address}`);
}
