import { hexDecode } from "@/shared/lib/matrix/functions";

/** Participant entry handed to Pcrypto (`id` is the hex Matrix id). */
export interface CryptoUsersInfoEntry {
  id: string;
  keys: string[];
  source: Record<string, unknown>;
}

/** Cached own encryption identity (see self-profile-cache `keys` / `id`). */
export interface SelfCryptoIdentity {
  keys: string[];
  id: number | string;
}

type SdkUser = Record<string, unknown> & { export?: (strip?: boolean) => Record<string, unknown> };

export interface CryptoUsersInfoDeps {
  /** Raw Bastyon address of the logged-in account. */
  selfAddress: string;
  requiredKeys: number;
  loadUsersInfo: (addresses: string[], options: { update: boolean }) => Promise<void>;
  getUserData: (address: string) => unknown;
  readSelfIdentity: () => SelfCryptoIdentity | null;
  writeSelfIdentity: (identity: SelfCryptoIdentity & { name?: string }) => void;
}

function keysOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((k): k is string => typeof k === "string" && !!k);
  if (typeof value === "string" && value) return value.split(",").filter(k => k);
  return [];
}

function sdkKeys(user: SdkUser | null): string[] {
  return keysOf(user?.keys);
}

/**
 * Resolve participants' encryption keys for Pcrypto `getusersinfo`.
 *
 * Without a forced refresh, nobody whose keys are already in SDK memory is
 * sent to the SDK again.
 *
 * The own account is resolved without the network whenever possible: from
 * the SDK memory, else from the self-profile cache. Sending it to the SDK
 * while its own-profile request (fetchUserInfo) hangs on a dead proxy made
 * every room's getusersinfo join that request and time out — the room then
 * had no keys and every send failed with "peer keys unavailable", although
 * all keys were cached locally. It still goes to the SDK when neither has
 * the keys, and on an explicit forced refresh.
 */
export async function resolveCryptoUsersInfo(
  ids: string[],
  options: { forceUpdate?: boolean } | undefined,
  deps: CryptoUsersInfoDeps,
): Promise<CryptoUsersInfoEntry[]> {
  const forceUpdate = options?.forceUpdate ?? false;
  const rawAddresses = ids.map((id) => hexDecode(id));
  const getSdkUser = (addr: string) => (deps.getUserData(addr) as SdkUser | null) ?? null;

  const selfIdentity = rawAddresses.includes(deps.selfAddress) ? deps.readSelfIdentity() : null;
  const selfFromCache = (selfIdentity?.keys.length ?? 0) >= deps.requiredKeys;
  // Participants whose keys are already in SDK memory are not asked again:
  // the SDK's loadList checks in-flight requests BEFORE its memory, so even a
  // cached address can latch onto someone else's hanging request.
  const toLoad = forceUpdate
    ? rawAddresses
    : rawAddresses.filter((addr) => {
      if (sdkKeys(getSdkUser(addr)).length >= deps.requiredKeys) return false;
      return !(addr === deps.selfAddress && selfFromCache);
    });

  // Single SDK load (getuserprofile once per batch); raw rows stored pre-cleanData in SDK.
  // forceUpdate bypasses the SDK's in-memory profile cache — only set
  // from an explicit user retry (peer-keys "Retry" button), never from
  // an automatic recheck, so a stale cached peer profile (e.g. fetched
  // before they had keys) can't get stuck for the rest of the session.
  if (toLoad.length > 0) {
    await deps.loadUsersInfo(toLoad, { update: forceUpdate }).catch((e) => {
      console.warn("[pcrypto] loadUsersInfo failed:", e);
    });
  }

  return ids.map((hexId, idx) => {
    const rawAddr = rawAddresses[idx];
    const sdkUser = getSdkUser(rawAddr);
    const exported = sdkUser && typeof sdkUser.address === "string"
      ? (typeof sdkUser.export === "function" ? sdkUser.export(true) : sdkUser)
      : null;

    let keys = sdkKeys(sdkUser);
    // Fallback: if SDK keys empty (e.g. filterXSS error in cleanData),
    // extract keys directly from the exported profile (k or keys field).
    if (keys.length === 0 && exported) keys = keysOf(exported.k ?? exported.keys);

    // Ensure source always has a numeric `id` field for deterministic
    // sort order in preparedUsers (must match lodash _.sortBy(u => u.source.id)
    // used by the old bastyon-chat client).
    // Priority: exported profile (has Pocketnet numeric id) > sdkUser > empty.
    const source: Record<string, unknown> = exported
      ? exported
      : (sdkUser ? { ...sdkUser, address: rawAddr } : { address: rawAddr });
    if (source.id == null && sdkUser?.id != null) source.id = sdkUser.id;

    if (rawAddr === deps.selfAddress) {
      if (keys.length >= deps.requiredKeys && source.id != null) {
        deps.writeSelfIdentity({
          keys,
          id: source.id as number | string,
          name: typeof sdkUser?.name === "string" ? sdkUser.name : undefined,
        });
      } else if (selfIdentity && selfIdentity.keys.length >= deps.requiredKeys) {
        keys = [...selfIdentity.keys];
        if (source.id == null) source.id = selfIdentity.id;
      }
    }

    return { id: hexId, keys, source };
  });
}
