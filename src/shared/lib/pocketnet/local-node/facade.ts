import { isRpcAllowed } from "./allowlist";
import { LocalNodeCache } from "./cache";
import { LocalNodeCatalogStore } from "./catalog-store";
import { LOCAL_NODE_CONSTANTS } from "./constants";
import { LocalNodeManager } from "./manager";
import { LocalNodePeertube } from "./peertube";
import { hasRpcScenario, runFeedScenario } from "./rpc-scenarios";
import type { LocalNode } from "./node";

export interface LocalNodeRpcOptions {
  node?: string;
  ex?: boolean;
  updateRPCCache?: boolean;
  timeout?: number;
}

/**
 * Client-side Local Node Proxy facade — demand-driven init, allowlisted RPC,
 * slim cache, optional rpc-ex feed enrichment.
 */
export class LocalNodeProxy {
  private manager: LocalNodeManager | null = null;
  private cache = new LocalNodeCache();
  private peertube: LocalNodePeertube | null = null;
  private current: LocalNode | null = null;
  private readonly store: LocalNodeCatalogStore;
  private readonly tls?: boolean;

  constructor(opts?: { store?: LocalNodeCatalogStore; tls?: boolean }) {
    this.store = opts?.store ?? new LocalNodeCatalogStore();
    this.tls = opts?.tls;
  }

  private getManager(): LocalNodeManager {
    if (!this.manager) {
      this.manager = new LocalNodeManager({ store: this.store, tls: this.tls });
    }
    return this.manager;
  }

  private getPeertube(): LocalNodePeertube {
    if (!this.peertube) this.peertube = new LocalNodePeertube();
    return this.peertube;
  }

  async ensureActive(): Promise<void> {
    await this.getManager().ensureActive();
  }

  /**
   * Kick init and return as soon as any seed is usable — do not wait for the
   * full probe batch (dead seeds can take HEALTH_TIMEOUT each via Promise.all).
   */
  async ping(timeoutMs: number = LOCAL_NODE_CONSTANTS.WAIT_READY_MS): Promise<boolean> {
    const manager = this.getManager();
    void manager.ensureActive().catch(() => undefined);
    return manager.waitreadywithrating(timeoutMs);
  }

  private pickNode(opts: LocalNodeRpcOptions, manager: LocalNodeManager): LocalNode | null {
    if (opts.node && manager.nodesmap[opts.node]) {
      const n = manager.nodesmap[opts.node];
      if (n.canuse && n.allowRpc) return n;
    }
    if (this.current && this.current.canuse && this.current.allowRpc) {
      return this.current;
    }
    return manager.selectProbability() ?? manager.selectbest();
  }

  async rpc(
    method: string,
    parameters: unknown[] = [],
    rpcOptions: LocalNodeRpcOptions = {},
  ): Promise<unknown> {
    if (!isRpcAllowed(method)) {
      throw { code: -32601, message: "methodnotallowed" };
    }

    if (rpcOptions.ex === true && hasRpcScenario(method)) {
      const { ex: _ex, ...rest } = rpcOptions;
      return runFeedScenario(method, {
        parameters,
        options: rest,
        rpc: (m, p, o) => this.rpc(m, p, o as LocalNodeRpcOptions),
        peertube: this.getPeertube(),
      });
    }

    await this.ensureActive();
    const manager = this.getManager();

    const dispatch = async (): Promise<unknown> => {
      let node = this.pickNode(rpcOptions, manager);
      if (!node) {
        await manager.waitreadywithrating();
        node = this.pickNode(rpcOptions, manager);
      }
      if (!node) {
        throw { code: -1, message: "nolocalnodes" };
      }

      try {
        const result = await manager.requestRpc(node, method, parameters, {
          timeout: rpcOptions.timeout,
        });
        this.current = node;
        return result;
      } catch (err) {
        const code =
          err && typeof err === "object" && "code" in err
            ? (err as { code: number }).code
            : 0;
        // Soft-retry on another canuse node for timeout/rate-limit style codes.
        if (code === 408 || code === 429 || code === 521 || code === 0) {
          const alt = manager
            .canuseNodes()
            .find((n) => n.key !== node!.key);
          if (alt) {
            const result = await manager.requestRpc(alt, method, parameters, {
              timeout: rpcOptions.timeout,
            });
            this.current = alt;
            return result;
          }
        }
        throw err;
      }
    };

    const cacheKey = this.cache.cacheKey(method, parameters);
    return this.cache.wrap(
      cacheKey,
      method,
      rpcOptions.updateRPCCache === true,
      dispatch,
    );
  }

  /** Fire-and-forget peer discovery after first successful use. */
  async maybeDiscover(): Promise<void> {
    try {
      await this.ensureActive();
      await this.getManager().discoverPeers();
    } catch {
      /* ignore */
    }
  }

  async destroy(): Promise<void> {
    this.cache.clear();
    this.peertube?.destroy();
    this.peertube = null;
    this.current = null;
    if (this.manager) {
      await this.manager.destroy();
      this.manager = null;
    }
  }
}

let shared: LocalNodeProxy | null = null;

/** Process-wide singleton used by callPocketnetRpc. */
export function getSharedLocalNodeProxy(): LocalNodeProxy {
  if (!shared) shared = new LocalNodeProxy();
  return shared;
}

/** Test helper. */
export function resetSharedLocalNodeProxy(): void {
  const prev = shared;
  shared = null;
  void prev?.destroy();
}
