import type { User } from "./types";

/**
 * Merge fresh profile data into a cached entry without overwriting non-empty
 * cached fields with empty values from upstream.
 *
 * Pocketnet RPC sometimes returns an empty `image` (or `name`) for a known
 * user — transient server state, race after edit, etc. The previous code in
 * user-store.ts overwrote the cached avatar with "", which surfaced as
 * #368 ("Аватарка ежедневно исчезает из профиля") on the daily revalidate.
 *
 * Encryption `keys` / Pocketnet `id` follow the same rule: a complete key set
 * from upstream replaces the cache; an empty/partial response must not wipe
 * keys we already hold (offline decrypt depends on them).
 */
export function mergeUserUpdate(
  prev: User | null | undefined,
  fresh: Partial<User>,
  now: number = Date.now(),
): User {
  if (!prev) {
    return {
      address: fresh.address ?? "",
      name: fresh.name ?? "",
      image: fresh.image ?? "",
      about: fresh.about ?? "",
      site: fresh.site ?? "",
      language: fresh.language ?? "",
      cachedAt: now,
      keys: fresh.keys && fresh.keys.length > 0 ? [...fresh.keys] : undefined,
      id: fresh.id,
    };
  }

  return {
    address: prev.address,
    name: pick(fresh.name, prev.name),
    image: pick(fresh.image, prev.image),
    about: pick(fresh.about, prev.about),
    site: pick(fresh.site, prev.site),
    language: pick(fresh.language, prev.language),
    cachedAt: now,
    keys: pickKeys(fresh.keys, prev.keys),
    id: fresh.id != null ? fresh.id : prev.id,
  };
}

function pick(fresh: string | undefined, prev: string): string {
  return fresh && fresh.trim() ? fresh : prev;
}

/** Prefer a complete (≥12) fresh set; never replace a good cache with empty. */
function pickKeys(
  fresh: string[] | undefined,
  prev: string[] | undefined,
): string[] | undefined {
  if (fresh && fresh.length >= 12) return [...fresh];
  if (prev && prev.length > 0) return prev;
  if (fresh && fresh.length > 0) return [...fresh];
  return prev;
}
