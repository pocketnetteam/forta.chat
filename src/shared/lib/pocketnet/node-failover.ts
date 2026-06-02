/**
 * Health-aware failover for direct Pocketnet RPC fetches (`N.pocketnet.app:8899`).
 *
 * Several app-level calls (`getsubscribeschannels`, `getprofilefeed`,
 * `getnodeinfo` for the Pcrypto block height) hit a single hardcoded node. When
 * that node returns 502 (or is unreachable) the call fails outright — and
 * because the block height feeds Pcrypto, encryption key derivation breaks too.
 *
 * This rotates over the configured proxy node list: a 502/503/504/429 or a
 * network error moves on to the next node; a non-retriable client error (4xx)
 * stops early since every node would answer the same. The last good node is
 * remembered (sticky) so subsequent calls start from a known-healthy host.
 *
 * Note: the Bastyon SDK `Api.rpc()` path has its own internal node handling;
 * this helper covers the app's *direct* fetches, which had no failover.
 */

export interface ProxyNode {
  host: string;
  port: number;
}

/** Pocketnet JSON-RPC envelope. The payload may sit under `data`, `result`, or
 *  at the top level depending on the method, so callers narrow defensively. */
export interface RpcEnvelope<T> {
  error?: unknown;
  data?: T;
  result?: T;
}

/** HTTP statuses that mean "this node is unhealthy — try another". 0 = network/no response. */
export const RETRIABLE_NODE_STATUSES: ReadonlySet<number> = new Set([0, 429, 502, 503, 504]);

export function isRetriableNodeStatus(status: number): boolean {
  return RETRIABLE_NODE_STATUSES.has(status);
}

/** Build `https://host:port` base URLs from the configured proxy list, with a safe default. */
export function buildNodeBaseUrls(
  proxies: readonly ProxyNode[] | null | undefined
): string[] {
  if (!proxies || proxies.length === 0) {
    return ["https://1.pocketnet.app:8899"];
  }
  return proxies.map((p) => `https://${p.host}:${p.port}`);
}

export interface RpcFailoverOptions {
  /** Base URLs to try, in order (see {@link buildNodeBaseUrls}). */
  nodes: string[];
  /** Injectable for tests; defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Override the sticky start index (tests). */
  startIndex?: number;
  /** Injectable clock (ms) for deterministic cooldown tests; defaults to Date.now(). */
  nowMs?: number;
  /** Cooldown for a failed node before it is retried; defaults to {@link NODE_COOLDOWN_MS}. */
  cooldownMs?: number;
}

/** How long a node that returned 502/network-error stays "cut off" before retry. */
export const NODE_COOLDOWN_MS = 30_000;

// Sticky last-good node index, shared across calls (mirrors ProxyRotator).
let stickyIndex = 0;
// Circuit breaker: nodeBaseUrl → timestamp (ms) until which the node is cut off.
const disabledUntil = new Map<string, number>();

function isNodeDisabled(node: string, nowMs: number): boolean {
  return (disabledUntil.get(node) ?? 0) > nowMs;
}

/** Cut a failing node off for the cooldown window so later calls skip it. */
function disableNode(node: string, nowMs: number, cooldownMs: number): void {
  disabledUntil.set(node, nowMs + cooldownMs);
  console.warn(`[node-failover] ${node} cut off for ${Math.round(cooldownMs / 1000)}s`);
}

/** Mark a node healthy again (clears any cooldown). */
function enableNode(node: string): void {
  disabledUntil.delete(node);
}

/**
 * Attempt order for one call: healthy nodes first (rotated from the sticky
 * last-good index), then any cut-off nodes ordered by soonest recovery. The
 * cut-off ones are still appended so a call never hard-fails just because every
 * node happens to be in cooldown — but across calls a 502 node is skipped until
 * it recovers.
 */
function orderedCandidates(nodes: string[], start: number, nowMs: number): string[] {
  const rotated = nodes.map((_, i) => nodes[(start + i) % nodes.length]);
  const healthy = rotated.filter((n) => !isNodeDisabled(n, nowMs));
  const disabled = rotated
    .filter((n) => isNodeDisabled(n, nowMs))
    .sort((a, b) => (disabledUntil.get(a) ?? 0) - (disabledUntil.get(b) ?? 0));
  return [...healthy, ...disabled];
}

/** Reset all failover state (test isolation / explicit re-evaluation). */
export function resetNodeFailover(): void {
  stickyIndex = 0;
  disabledUntil.clear();
}

/**
 * POST a JSON-RPC body to `<node><path>`, rotating across nodes on
 * 502/503/504/429/network failures. A failing node is cut off for a cooldown
 * window so subsequent calls skip straight to a healthy node. Returns the parsed
 * JSON of the first healthy node; throws an aggregate error when every node fails.
 */
export async function rpcFetchWithFailover(
  path: string,
  body: unknown,
  opts: RpcFailoverOptions
): Promise<unknown> {
  const { nodes } = opts;
  if (nodes.length === 0) {
    throw new Error("[node-failover] no Pocketnet nodes configured");
  }
  const doFetch = opts.fetchImpl ?? fetch;
  const nowMs = opts.nowMs ?? Date.now();
  const cooldownMs = opts.cooldownMs ?? NODE_COOLDOWN_MS;
  const start = opts.startIndex ?? stickyIndex;
  const errors: string[] = [];

  for (const base of orderedCandidates(nodes, start, nowMs)) {
    let response: Response;
    try {
      response = await doFetch(`${base}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (e) {
      // Network error / abort → cut the node off and try the next one.
      errors.push(`${base}: ${e instanceof Error ? e.message : String(e)}`);
      disableNode(base, nowMs, cooldownMs);
      continue;
    }

    if (response.ok) {
      // Note: an HTTP-200 body carrying an RPC-level `{ error }` is returned as-is
      // (no failover) — the gateway answered, so the caller decides. This matches
      // the prior single-node behaviour; widening failover to RPC-level errors
      // risks masking genuine bad-param/not-found errors.
      enableNode(base); // healthy again
      stickyIndex = nodes.indexOf(base); // remember it for next time
      return await response.json();
    }

    errors.push(`${base}: HTTP ${response.status}`);
    if (!isRetriableNodeStatus(response.status)) {
      // Client-side error (4xx etc.) — the node is fine, the request isn't;
      // don't cut it off and don't waste calls on other nodes.
      throw new Error(`[node-failover] non-retriable HTTP ${response.status} from ${base}${path}`);
    }
    disableNode(base, nowMs, cooldownMs);
  }

  throw new Error(`[node-failover] all nodes failed for ${path}: ${errors.join("; ")}`);
}
