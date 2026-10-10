import type { BastyonProfileTarget } from "@/shared/lib/bastyon-link";
import { withTimeout } from "@/shared/lib/with-timeout";

/** A lookup that has not answered by then counts as failed (slow networks, Tor). */
export const NAME_LOOKUP_TIMEOUT_MS = 15_000;

/** Username → address lookups shared by every card of the session: a name
 *  posted many times in a chat costs one getuseraddress RPC. Failed and
 *  timed-out lookups are dropped so a later card can retry. */
const nameLookups = new Map<string, Promise<string | null>>();

/**
 * Resolve the address a profile link points to. A link by address resolves
 * as is; a link by username goes through `lookupName` (getuseraddress).
 */
export async function resolveProfileAddress(
  target: BastyonProfileTarget,
  lookupName: (name: string) => Promise<string | null>,
): Promise<string | null> {
  if (target.address) return target.address;
  if (!target.name) return null;

  const key = target.name.toLowerCase();
  let lookup = nameLookups.get(key);
  if (!lookup) {
    lookup = withTimeout(lookupName(target.name), NAME_LOOKUP_TIMEOUT_MS, "getuseraddress")
      .catch(() => null);
    nameLookups.set(key, lookup);
  }
  const address = await lookup;
  if (!address && nameLookups.get(key) === lookup) nameLookups.delete(key);
  return address;
}

/** Test hook: forget cached lookups. */
export function clearProfileAddressCache(): void {
  nameLookups.clear();
}
