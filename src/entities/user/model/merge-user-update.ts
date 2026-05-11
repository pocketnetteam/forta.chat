import type { User } from "./types";

/**
 * Merge fresh profile data into a cached entry without overwriting non-empty
 * cached fields with empty values from upstream.
 *
 * Pocketnet RPC sometimes returns an empty `image` (or `name`) for a known
 * user — transient server state, race after edit, etc. The previous code in
 * user-store.ts overwrote the cached avatar with "", which surfaced as
 * #368 ("Аватарка ежедневно исчезает из профиля") on the daily revalidate.
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
  };
}

function pick(fresh: string | undefined, prev: string): string {
  return fresh && fresh.trim() ? fresh : prev;
}
