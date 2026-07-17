/**
 * Centralized Pocketnet RPC client (WEE-35).
 *
 * Single entry point for direct `*.pocketnet.app:8899` RPC calls so every
 * request goes through the same node failover + circuit breaker
 * (see {@link rpcFetchWithFailover}). Configure the node pool once at startup
 * with {@link configurePocketnetNodes}; callers then just name the method.
 */

import {
  rpcFetchWithFailover,
  buildNodeBaseUrls,
  type RpcEnvelope,
} from "./node-failover";

let configuredNodes: string[] = [];

/** Set the gateway node pool (e.g. from `listofproxies`). Call once at init. */
export function configurePocketnetNodes(nodeBaseUrls: string[]): void {
  configuredNodes = nodeBaseUrls;
}

/** Current node pool, falling back to the safe default when unconfigured. */
export function getConfiguredPocketnetNodes(): string[] {
  return configuredNodes.length > 0 ? configuredNodes : buildNodeBaseUrls(null);
}

export interface PocketnetRpcRequest {
  /** RPC method name, e.g. "getnodeinfo", "getprofilefeed". */
  method: string;
  /** Positional RPC parameters. */
  parameters?: unknown[];
  /** Optional backend node id, sent as `options.node`. */
  node?: string;
  /** Override the node pool (defaults to the configured pool). */
  nodes?: string[];
}

/**
 * Call a Pocketnet RPC method with cross-node failover. Returns the raw
 * envelope; use {@link unwrapRpcPayload} to extract the data/result/top-level
 * payload. Throws when every node fails.
 */
export async function callPocketnetRpc<T = unknown>(
  req: PocketnetRpcRequest
): Promise<RpcEnvelope<T> & Partial<T>> {
  const body: Record<string, unknown> = {
    method: req.method,
    parameters: req.parameters ?? [],
  };
  if (req.node) {
    body.options = { node: req.node };
  }
  const json = await rpcFetchWithFailover(`/rpc/${req.method}`, body, {
    nodes: req.nodes ?? getConfiguredPocketnetNodes(),
  });
  return json as RpcEnvelope<T> & Partial<T>;
}

/** Extract the payload from an RPC envelope: `data` → `result` → the body itself. */
export function unwrapRpcPayload<T>(envelope: RpcEnvelope<T> & Partial<T>): T {
  return (envelope.data ?? envelope.result ?? (envelope as unknown as T)) as T;
}
