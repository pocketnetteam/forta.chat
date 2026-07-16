/**
 * UTXO selection + resilient `txunspent` fetching.
 *
 * Background (WEE-72): on "fat" addresses the Pocketnet C++ node cannot finish
 * the `GetUnspents` SQL query within its timeout and returns HTTP 408. Forta
 * used to call `txunspent` live on every fee calculation, with no retry and no
 * input cap, so the first timeout flew straight into the UI as raw JSON.
 *
 * This module centralises the wallet's UTXO logic so the store can cache it and
 * retry timeouts the way the reference Bastyon client does.
 */

export interface UTXO {
  txid: string;
  vout: number;
  address: string;
  amount: number;
  amountSat: number;
  scriptPubKey: string;
  confirmations: number;
}

export const SATOSHI = 100_000_000;
export const DUST_LIMIT = 700; // satoshis

/**
 * Cap on how many inputs a single transaction will use. Mirrors the reference
 * client's `optimizeUnspentsMax: 300` — we never select (and therefore never
 * sign) more than this, even on addresses with thousands of UTXOs.
 */
export const MAX_INPUTS = 300;

/** Minimal shape of the Pocketnet SDK `Api` we depend on for fetching UTXOs. */
export interface UnspentRpcClient {
  rpc(
    method: string,
    params?: unknown[],
    options?: { node?: string; fnode?: string; ex?: boolean },
  ): Promise<unknown>;
}

/**
 * Error code thrown when the balance is sufficient in total, but spread across
 * more than {@link MAX_INPUTS} small UTXOs so the top-N can't cover the target.
 * Distinct from "Insufficient balance" so the UI can show a correct message
 * instead of contradicting the balance the user can see.
 */
export const ERR_TOO_MANY_INPUTS = "TOO_MANY_INPUTS";

/**
 * Select UTXOs (largest first) to cover `targetSat`, capped at {@link MAX_INPUTS}.
 * Returns `[selected, totalSat]`.
 *
 * Throws `"Insufficient balance"` when the UTXOs genuinely can't cover the
 * target, or {@link ERR_TOO_MANY_INPUTS} when only the per-tx input cap (not
 * the balance) is the limiting factor.
 */
export function selectUtxos(utxos: UTXO[], targetSat: number): [UTXO[], number] {
  // Sort by amount descending — prefer fewer, larger UTXOs
  const sorted = [...utxos].sort((a, b) => b.amountSat - a.amountSat);
  const selected: UTXO[] = [];
  let sum = 0;
  for (const u of sorted) {
    if (selected.length >= MAX_INPUTS) break;
    selected.push(u);
    sum += u.amountSat;
    if (sum >= targetSat) break;
  }
  if (sum < targetSat) {
    // Hit the input cap while more UTXOs remain → funds are too fragmented.
    if (selected.length >= MAX_INPUTS && sorted.length > MAX_INPUTS) {
      throw new Error(ERR_TOO_MANY_INPUTS);
    }
    throw new Error("Insufficient balance");
  }
  return [selected, sum];
}

/**
 * Whether `err` looks like a node timeout / overload we should retry.
 * Covers the `{ code: 408, message: "GetUnspents: sql request timeout" }`
 * shape from the bug report plus the SDK's other retryable codes.
 */
export function isTimeoutError(err: unknown): boolean {
  if (err == null) return false;
  if (typeof err === "string") return /timeout|408|GetUnspents/i.test(err);
  if (typeof err !== "object") return false;

  const code = (err as { code?: unknown }).code;
  if (code === 408 || code === 429 || code === -28) return true;

  const message = (err as { message?: unknown }).message;
  if (typeof message === "string" && /timeout|\b408\b|GetUnspents/i.test(message)) return true;

  // Nested Pocketnet RPC shape: { error: { code, message } } | { error: "..." }
  const nested = (err as { error?: unknown }).error;
  if (nested != null && nested !== err) return isTimeoutError(nested);

  return false;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface FetchUnspentsOptions {
  /** Extra retries after the first attempt. Default 2 (→ up to 3 attempts). */
  retries?: number;
  /** Base backoff in ms; grows exponentially with jitter. Default 400. */
  baseDelayMs?: number;
  /** Max single backoff in ms. Default 4000. */
  maxDelayMs?: number;
}

/**
 * Fetch all UTXOs for `address` via `txunspent`, retrying on node timeouts
 * (408/429/-28) with exponential backoff + jitter. Each retry re-issues the RPC
 * so the SDK can rotate to a different node. Non-timeout errors fail fast.
 */
export async function fetchUnspents(
  api: UnspentRpcClient,
  address: string,
  options: FetchUnspentsOptions = {},
): Promise<UTXO[]> {
  const retries = options.retries ?? 2;
  const baseDelayMs = options.baseDelayMs ?? 400;
  const maxDelayMs = options.maxDelayMs ?? 4000;

  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return (await api.rpc("txunspent", [[address], 1, 9999999])) as UTXO[];
    } catch (err) {
      lastErr = err;
      if (!isTimeoutError(err) || attempt === retries) break;
      const backoff = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
      const jitter = Math.random() * baseDelayMs;
      await delay(backoff + jitter);
    }
  }
  throw lastErr;
}
