/**
 * Centralized Pocketnet RPC client (WEE-35).
 *
 * Single entry point for direct `*.pocketnet.app:8899` RPC calls so every
 * request goes through the same node failover + circuit breaker
 * (see {@link rpcFetchWithFailover}). Configure the node pool once at startup
 * with {@link configurePocketnetNodes}; callers then just name the method.
 *
 * Routing (proxy store): gateway/auto → failover; local → Local Node Proxy;
 * auto last-resort falls back to Local when all gateways fail.
 */

import {
  rpcFetchWithFailover,
  buildNodeBaseUrls,
  type RpcEnvelope,
} from "./node-failover";
import { getSharedLocalNodeProxy } from "./local-node";

let configuredNodes: string[] = [];

/** Optional router from the proxy settings store (avoids hard Pinia dep here). */
export interface PocketnetRpcRouter {
  shouldUseLocal(): boolean;
  allowLocalFallback(): boolean;
  /** Ordered gateway base URLs; null/empty → configured pool. */
  gatewayBaseUrls(): string[] | null;
}

let rpcRouter: PocketnetRpcRouter | null = null;

export function setPocketnetRpcRouter(router: PocketnetRpcRouter | null): void {
  rpcRouter = router;
}

export function getPocketnetRpcRouter(): PocketnetRpcRouter | null {
  return rpcRouter;
}

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
  /**
   * `rpc-ex` answers the same methods with related data attached (e.g.
   * getprofilefeed: the PeerTube video objects and the author profiles).
   */
  endpoint?: "rpc" | "rpc-ex";
  /**
   * Force gateway-only path (registration / captcha). Ignores Local mode and
   * Local auto-fallback.
   */
  gatewaysOnly?: boolean;
}

function resolveGatewayNodes(req: PocketnetRpcRequest): string[] {
  if (req.nodes && req.nodes.length > 0) return req.nodes;
  const fromRouter = rpcRouter?.gatewayBaseUrls();
  if (fromRouter && fromRouter.length > 0) return fromRouter;
  return getConfiguredPocketnetNodes();
}

async function callViaLocalNode<T>(
  req: PocketnetRpcRequest,
): Promise<RpcEnvelope<T> & Partial<T>> {
  const proxy = getSharedLocalNodeProxy();
  const result = await proxy.rpc(req.method, req.parameters ?? [], {
    node: req.node,
    ex: req.endpoint === "rpc-ex",
  });
  // Match gateway envelope shape so unwrapRpcPayload keeps working.
  return { data: result as T } as RpcEnvelope<T> & Partial<T>;
}

async function callViaGateways<T>(
  req: PocketnetRpcRequest,
): Promise<RpcEnvelope<T> & Partial<T>> {
  const body: Record<string, unknown> = {
    method: req.method,
    parameters: req.parameters ?? [],
  };
  if (req.node) {
    body.options = { node: req.node };
  }
  const json = await rpcFetchWithFailover(
    `/${req.endpoint ?? "rpc"}/${req.method}`,
    body,
    { nodes: resolveGatewayNodes(req) },
  );
  return json as RpcEnvelope<T> & Partial<T>;
}

/**
 * Call a Pocketnet RPC method with cross-node failover (or Local Node Proxy).
 * Returns the raw envelope; use {@link unwrapRpcPayload} to extract the payload.
 */
export async function callPocketnetRpc<T = unknown>(
  req: PocketnetRpcRequest,
): Promise<RpcEnvelope<T> & Partial<T>> {
  const useLocal = !req.gatewaysOnly && rpcRouter?.shouldUseLocal() === true;
  if (useLocal) {
    return callViaLocalNode<T>(req);
  }

  try {
    return await callViaGateways<T>(req);
  } catch (gatewayErr) {
    if (req.gatewaysOnly || rpcRouter?.allowLocalFallback() !== true) {
      throw gatewayErr;
    }
    try {
      return await callViaLocalNode<T>(req);
    } catch {
      throw gatewayErr;
    }
  }
}

/** Extract the payload from an RPC envelope: `data` → `result` → the body itself. */
export function unwrapRpcPayload<T>(envelope: RpcEnvelope<T> & Partial<T>): T {
  return (envelope.data ?? envelope.result ?? (envelope as unknown as T)) as T;
}
