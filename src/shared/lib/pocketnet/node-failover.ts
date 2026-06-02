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
}

// Sticky last-good node index, shared across calls (mirrors ProxyRotator).
let stickyIndex = 0;

/** Reset sticky state (test isolation / explicit re-evaluation). */
export function resetNodeFailover(): void {
  stickyIndex = 0;
}

/**
 * POST a JSON-RPC body to `<node><path>`, rotating across nodes on
 * 502/503/504/429/network failures. Returns the parsed JSON of the first
 * healthy node. Throws an aggregate error when every node fails.
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
  const start = opts.startIndex ?? stickyIndex;
  const errors: string[] = [];

  for (let attempt = 0; attempt < nodes.length; attempt++) {
    const idx = (start + attempt) % nodes.length;
    const base = nodes[idx];

    let response: Response;
    try {
      response = await doFetch(`${base}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (e) {
      // Network error / abort → unhealthy node, try the next one.
      errors.push(`${base}: ${e instanceof Error ? e.message : String(e)}`);
      console.warn(`[node-failover] ${base}${path} network error — trying next node`);
      continue;
    }

    if (response.ok) {
      // Note: an HTTP-200 body carrying an RPC-level `{ error }` is returned as-is
      // (no failover) — the gateway answered, so the caller decides. This matches
      // the prior single-node behaviour; widening failover to RPC-level errors
      // risks masking genuine bad-param/not-found errors.
      stickyIndex = idx; // remember the healthy node for next time
      return await response.json();
    }

    errors.push(`${base}: HTTP ${response.status}`);
    if (!isRetriableNodeStatus(response.status)) {
      // Client-side error (4xx etc.) — other nodes would answer the same.
      throw new Error(`[node-failover] non-retriable HTTP ${response.status} from ${base}${path}`);
    }
    console.warn(`[node-failover] ${base}${path} HTTP ${response.status} — trying next node`);
  }

  throw new Error(`[node-failover] all nodes failed for ${path}: ${errors.join("; ")}`);
}
