/**
 * Self-profile persistence + merge helpers (WEE-26, forta-bugs#596, #580).
 *
 * Forta identity is two-layered: Pocketnet blockchain (authoritative) +
 * Matrix room state (peer-visible). The blockchain `updateProfile` commit
 * is asynchronous — for some minutes/hours after a save, the proxied
 * `getuserprofile` RPC can still return the *pre-edit* name. Before this
 * module existed, that stale RPC value overwrote the local in-memory
 * `userInfo` and the `useUserStore` cache, so users opened the app after
 * an update and saw their name reverted to a previous value.
 *
 * Strategy: persist a small self-profile snapshot to localStorage with a
 * `localEditedAt` timestamp. While that timestamp is within the propagation
 * grace window, prefer the cached values for the user-facing display
 * fields (name/about/image/site/language) when the remote disagrees. Once
 * the window elapses, the remote wins — so cross-device edits propagate.
 *
 * localStorage rather than Dexie: this snapshot must be available *before*
 * Dexie is initialized (Dexie init happens inside `initMatrix`, which runs
 * after `fetchUserInfo`).
 */
import type { UserData } from "@/app/providers/initializers/types";

/** localStorage key prefix; final key is `${PREFIX}${address}`. */
const KEY_PREFIX = "forta-chat-self-profile:";

/** How long after a local edit we keep preferring the cached value over a
 *  conflicting remote response. Pocketnet propagation is normally minutes,
 *  but proxy/CDN caches and offline nodes can drag this out — 7d is the
 *  observed worst case in forta-bugs#596 reports. */
export const SELF_PROFILE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

export interface SelfProfileSnapshot {
  address: string;
  name: string;
  about: string;
  image: string;
  site: string;
  language: string;
  /** Epoch-ms of the last user-initiated save. 0 means "never edited locally". */
  localEditedAt: number;
  /** Epoch-ms of the last successful Pocketnet refresh. 0 means "never synced". */
  syncedAt: number;
}

function keyFor(address: string): string {
  return `${KEY_PREFIX}${address}`;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

/** Read the cached snapshot for an address, or null if absent / corrupt. */
export function readSelfProfile(address: string): SelfProfileSnapshot | null {
  if (!address) return null;
  const storage = safeStorage();
  if (!storage) return null;
  try {
    const raw = storage.getItem(keyFor(address));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const p = parsed as Record<string, unknown>;
    if (!isString(p.address) || p.address !== address) return null;
    return {
      address: p.address,
      name: isString(p.name) ? p.name : "",
      about: isString(p.about) ? p.about : "",
      image: isString(p.image) ? p.image : "",
      site: isString(p.site) ? p.site : "",
      language: isString(p.language) ? p.language : "",
      localEditedAt: isNumber(p.localEditedAt) ? p.localEditedAt : 0,
      syncedAt: isNumber(p.syncedAt) ? p.syncedAt : 0,
    };
  } catch {
    return null;
  }
}

/** Persist (overwrite) the self-profile snapshot.
 *  Empty-name snapshots are skipped — they would poison boot merges the same
 *  way an empty getuserprofile row poisons the user-store cache. */
export function writeSelfProfile(snapshot: SelfProfileSnapshot): void {
  if (!snapshot.address) return;
  if (!String(snapshot.name ?? "").trim()) return;
  const storage = safeStorage();
  if (!storage) return;
  try {
    storage.setItem(keyFor(snapshot.address), JSON.stringify(snapshot));
  } catch {
    // Quota / private-mode etc. — non-fatal; cache will simply not survive
    // this restart, falling back to remote-wins behaviour.
  }
}

/** Drop empty-name self-profile snapshots left by older builds. */
export function purgeEmptySelfProfiles(): number {
  const storage = safeStorage();
  if (!storage) return 0;
  let removed = 0;
  try {
    const toRemove: string[] = [];
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (!key || !key.startsWith(KEY_PREFIX)) continue;
      const raw = storage.getItem(key);
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw) as { name?: unknown };
        if (!String(parsed?.name ?? "").trim()) toRemove.push(key);
      } catch {
        toRemove.push(key);
      }
    }
    for (const key of toRemove) {
      storage.removeItem(key);
      removed++;
    }
  } catch {
    /* ignore */
  }
  return removed;
}

/** Drop the cached snapshot — typically on logout for the leaving account. */
export function clearSelfProfile(address: string): void {
  if (!address) return;
  const storage = safeStorage();
  if (!storage) return;
  try {
    storage.removeItem(keyFor(address));
  } catch {
    /* ignore */
  }
}

/** Pick the field value to display.
 *
 *  Two protections layered together:
 *
 *  1. Empty-remote fallback (always on, mirrors `entities/user mergeUserUpdate`):
 *     a non-empty cached value is never blanked out by an empty remote
 *     response. Pocketnet routinely returns empty rows on transient RPC
 *     errors, so the project consistently treats those as "no update" rather
 *     than a deliberate clear. Trade-off: a genuine cross-device *clear*
 *     would not propagate to a device that already has a cached value —
 *     accepted because users effectively never blank their own fields
 *     (they replace one value with another).
 *
 *  2. Grace-window conflict resolution (only when a recent local edit
 *     exists): when remote disagrees with the cached non-empty value, prefer
 *     cached. This is the WEE-26 fix — a stale `getuserprofile` response
 *     after a recent save would otherwise revert the name.
 */
function pickField(
  remote: string | undefined,
  cached: string,
  isRecentLocalEdit: boolean,
): string {
  const remoteStr = remote ?? "";
  if (!remoteStr && cached) return cached;
  if (isRecentLocalEdit && remoteStr !== cached && cached) return cached;
  return remoteStr;
}

/** Merge a remote UserData against the cached snapshot. The result preserves
 *  every authoritative field from `remote` (addresses, keys, ref, etc.) and
 *  only overrides the user-facing fields where the cache should win. */
export function mergeSelfProfileWithRemote(
  cached: SelfProfileSnapshot | null,
  remote: UserData,
  now: number = Date.now(),
): UserData {
  if (!cached) return remote;
  const isRecentLocalEdit =
    cached.localEditedAt > 0 && now - cached.localEditedAt < SELF_PROFILE_GRACE_MS;
  return {
    ...remote,
    name: pickField(remote.name, cached.name, isRecentLocalEdit),
    about: pickField(remote.about, cached.about, isRecentLocalEdit),
    image: pickField(remote.image, cached.image, isRecentLocalEdit),
    site: pickField(remote.site, cached.site, isRecentLocalEdit),
    language: pickField(remote.language, cached.language, isRecentLocalEdit),
  };
}
