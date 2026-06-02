/**
 * Decision logic for the login-time encryption-key verification path.
 *
 * Forta publishes 12 BIP32 encryption keys to the Pocketnet blockchain so peers
 * can E2E-encrypt chat to a user. On every login the app checks the account has
 * those keys and re-publishes them when missing.
 *
 * CRITICAL invariant (WEE-35 / forta-bugs#520):
 * This module deliberately has NO action that mounts the registration UI. The
 * key-verification path runs for an account that is *already authenticated*, so
 * flipping `registrationPending` (which mounts the full-screen
 * RegistrationStepper — "Подготовка аккаунта / Requesting resources for
 * registration on the network") over a valid session was a regression that hung
 * existing-account login. It bit hardest for Bastyon-registered accounts, whose
 * blockchain profile lacks Forta's 12 keys, and on transient empty-keys RPC
 * responses. Every outcome here keeps the user in the app; re-publishing is a
 * best-effort background operation, with manual recovery available from settings.
 */

/** Number of encryption keys Forta publishes per account. */
export const REQUIRED_ENCRYPTION_KEYS = 12;

export interface KeyRepublishInput {
  /** Keys reported by the local SDK cache (fast path). */
  cachedKeyCount: number;
  /** Keys confirmed on the blockchain via RPC, or null when not checked. */
  blockchainKeyCount: number | null;
  /** True when the blockchain RPC check threw — verification is inconclusive. */
  blockchainCheckFailed: boolean;
  /** Whether the account has PKOIN to fund a key-publish broadcast. */
  hasUnspents: boolean;
}

export type KeyRepublishAction =
  /** Enough keys present — nothing to do. */
  | { kind: "keys-ok"; source: "cache" | "blockchain"; keyCount: number }
  /** Verification failed (RPC error) — do not block login, do not republish. */
  | { kind: "rpc-failed" }
  /** Keys missing but no funds to broadcast — proceed; recover from settings. */
  | { kind: "needs-funds" }
  /** Keys missing and funded — re-publish silently in the background. */
  | { kind: "republish" };

/**
 * Resolve what the login-time key check should do. Pure and side-effect-free so
 * the regression invariant can be unit-tested directly.
 */
export function resolveKeyRepublishAction(
  input: KeyRepublishInput
): KeyRepublishAction {
  if (input.cachedKeyCount >= REQUIRED_ENCRYPTION_KEYS) {
    return { kind: "keys-ok", source: "cache", keyCount: input.cachedKeyCount };
  }

  // Cache is short — the blockchain is authoritative. A failed check is
  // inconclusive: never re-publish (and never block login) on a transient error.
  if (input.blockchainCheckFailed) {
    return { kind: "rpc-failed" };
  }

  const blockchainKeyCount = input.blockchainKeyCount ?? 0;
  if (blockchainKeyCount >= REQUIRED_ENCRYPTION_KEYS) {
    return { kind: "keys-ok", source: "blockchain", keyCount: blockchainKeyCount };
  }

  // Keys genuinely missing. Funded → background re-publish; otherwise proceed
  // into the app and let the user publish keys later from settings.
  return input.hasUnspents ? { kind: "republish" } : { kind: "needs-funds" };
}

/** Count keys reported by the local SDK cache (`userData.keys`). */
export function countCachedKeys(userData: unknown): number {
  const keys = (userData as { keys?: unknown } | null | undefined)?.keys;
  return Array.isArray(keys) ? keys.filter(Boolean).length : 0;
}

/**
 * Count published keys on a raw blockchain profile. Pocketnet returns the keys
 * either as an array or a comma-separated string under `k` (preferred) or
 * `keys` (legacy).
 */
export function countPublishedKeys(rawProfile: unknown): number {
  if (!rawProfile || typeof rawProfile !== "object") return 0;
  const raw =
    (rawProfile as { k?: unknown; keys?: unknown }).k ??
    (rawProfile as { k?: unknown; keys?: unknown }).keys ??
    "";
  if (Array.isArray(raw)) return raw.filter(Boolean).length;
  if (typeof raw === "string" && raw) {
    return raw.split(",").filter(Boolean).length;
  }
  return 0;
}
