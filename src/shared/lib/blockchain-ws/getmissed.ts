/**
 * Catch-up via RPC `getmissedinfo` — mirrors `js/satolist.js` `getMissed()`.
 *
 * Pocketnet node returns:
 *   d[0]      — block summary `{block, contentsLang, ...}` (treat as `newblocks`)
 *   d[1..N]   — list of missed events (transaction / event{userInfo} / etc.)
 *
 * The caller is responsible for piping each item back through the same
 * dispatcher used for live WS messages — that way dedupe (txid set) and
 * handler routing are shared between paths.
 */

import type { BlockchainWsRpcAdapter, InboundMessage } from "./types";

/** Default response cap (matches Bastyon: 30 events per call). */
const DEFAULT_LIMIT = 30;

/** Throttle window — refuse to call `getmissedinfo` again unless the last
 *  block update was older than this. Matches the 2-minute guard in the
 *  legacy `WSn.getMissed`. */
export const GETMISSED_MIN_INTERVAL_MS = 2 * 60 * 1_000;

export interface GetMissedOptions {
  api: BlockchainWsRpcAdapter;
  address: string;
  /** Last-known block height (used as starting point for catch-up). */
  fromBlock: number;
  limit?: number;
}

/** Result mirrors the legacy SDK shape: a synthetic block summary plus the
 *  list of missed events sorted newest-first. */
export interface GetMissedResult {
  block: InboundMessage;
  notifications: InboundMessage[];
}

/** Throttle helper. Mutable singleton because there's only ever one
 *  blockchain-ws connection per session. */
let _lastCallAt = 0;

/** For tests: reset the throttle gate. */
export function resetGetMissedThrottle(): void {
  _lastCallAt = 0;
}

/** Should we call `getmissedinfo` now?
 *  - First call is always allowed (`initial=true`).
 *  - Later calls are throttled by `GETMISSED_MIN_INTERVAL_MS`. */
export function canRunGetMissed(initial: boolean, now: number = Date.now()): boolean {
  if (initial) return true;
  if (_lastCallAt === 0) return true;
  return now - _lastCallAt >= GETMISSED_MIN_INTERVAL_MS;
}

/** Mark a successful `getmissedinfo` run — used to throttle subsequent calls. */
export function markGetMissedRan(now: number = Date.now()): void {
  _lastCallAt = now;
}

/**
 * Run RPC `getmissedinfo(address, fromBlock, limit)` and normalise the
 * response. Returns `null` when the RPC reports no data — callers should
 * still treat that as a successful (empty) catch-up.
 */
export async function fetchGetMissed(
  options: GetMissedOptions,
): Promise<GetMissedResult | null> {
  const { api, address, fromBlock, limit = DEFAULT_LIMIT } = options;

  if (!address) return null;
  if (!fromBlock || fromBlock <= 0) return null;

  let response: unknown;
  try {
    response = await api.rpc("getmissedinfo", [address, fromBlock, limit]);
  } catch {
    return null;
  }

  if (!Array.isArray(response) || response.length === 0) {
    return null;
  }

  const blockEntry = response[0] as InboundMessage;
  // Promote to the same `newblocks` envelope that live WS events use, so the
  // single dispatcher can handle both paths uniformly.
  blockEntry.msg = "newblocks";

  const notifications = (response.slice(1) as InboundMessage[]).slice();
  notifications.sort((a, b) => {
    const ab = Number(b?.nblock ?? 0);
    const aa = Number(a?.nblock ?? 0);
    return ab - aa;
  });

  return { block: blockEntry, notifications };
}
