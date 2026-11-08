import { pathForRpcMethod } from "./allowlist";
import { LocalNodeCatalogStore } from "./catalog-store";
import { LOCAL_NODE_CONSTANTS } from "./constants";
import { LocalNode } from "./node";
import { getTrustSeeds } from "./seeds";
import {
  buildJsonRpcBody,
  buildPostUrl,
  buildPublicUrl,
  localNodeRequest,
  resolveDefaultTls,
} from "./transport";
import type { SeedMeta, TransportError } from "./types";

function unwrapJsonRpc(body: unknown): unknown {
  if (!body || typeof body !== "object") return body;
  const obj = body as Record<string, unknown>;
  if (obj.error != null) {
    const err = obj.error;
    if (err && typeof err === "object") {
      const e = err as { code?: number; message?: string };
      throw { code: e.code ?? -1, message: e.message ?? "rpcerror" };
    }
    throw { code: -1, message: String(err) };
  }
  if ("result" in obj) return obj.result;
  if ("data" in obj) return obj.data;
  return body;
}

function mapTransportError(err: unknown): { code: number; message: string } {
  if (err && typeof err === "object" && "code" in err) {
    const e = err as TransportError;
    return { code: typeof e.code === "number" ? e.code : 0, message: e.message || "error" };
  }
  return { code: 0, message: err instanceof Error ? err.message : String(err) };
}

export class LocalNodeManager {
  nodes: LocalNode[] = [];
  nodesmap: Record<string, LocalNode> = {};
  bestnode = "";
  private bestapplyTimer: ReturnType<typeof setInterval> | null = null;
  private ready = false;
  private initPromise: Promise<void> | null = null;
  private rpcId = 1;
  private readonly tls: boolean;
  private readonly store: LocalNodeCatalogStore;
  private readonly now: () => number;
  private lastTouch = 0;
  private suspended = true;

  constructor(
    opts?: {
      tls?: boolean;
      store?: LocalNodeCatalogStore;
      now?: () => number;
    },
  ) {
    this.tls = resolveDefaultTls(opts?.tls);
    this.store = opts?.store ?? new LocalNodeCatalogStore();
    this.now = opts?.now ?? Date.now;
  }

  private addNode(meta: SeedMeta): LocalNode {
    const key = meta.key ?? `${meta.host}:${meta.port}`;
    const existing = this.nodesmap[key];
    if (existing) return existing;
    const node = new LocalNode({ ...meta, key }, { now: this.now });
    this.nodes.push(node);
    this.nodesmap[key] = node;
    return node;
  }

  canuseNodes(): LocalNode[] {
    return this.nodes.filter((n) => n.canuse && n.allowRpc);
  }

  selectbest(): LocalNode | null {
    const usable = this.canuseNodes();
    if (usable.length === 0) return null;
    let best = usable[0];
    let bestR = best.rating();
    for (let i = 1; i < usable.length; i++) {
      const r = usable[i].rating();
      if (r > bestR) {
        best = usable[i];
        bestR = r;
      }
    }
    this.bestnode = best.key;
    return best;
  }

  selectProbability(): LocalNode | null {
    const usable = this.canuseNodes().filter((n) => n.rating() > 0);
    if (usable.length === 0) return this.selectbest();
    const total = usable.reduce((s, n) => s + n.rating(), 0);
    if (total <= 0) return usable[0];
    let cursor = Math.random() * total;
    for (const n of usable) {
      cursor -= n.rating();
      if (cursor <= 0) return n;
    }
    return usable[usable.length - 1];
  }

  private async probeNode(node: LocalNode): Promise<boolean> {
    try {
      const info = (await this.requestRpc(node, "getnodeinfo", [], {
        timeout: LOCAL_NODE_CONSTANTS.HEALTH_TIMEOUT_MS,
      })) as {
        version?: string;
        versioncode?: number;
        chain?: string;
        height?: number;
        lastblock?: { height?: number };
      };
      if (
        info?.version &&
        LOCAL_NODE_CONSTANTS.BAD_NODE_VERSIONS.includes(info.version)
      ) {
        node.canuse = false;
        return false;
      }
      node.markFromNodeInfo(info ?? {});
      return true;
    } catch {
      node.canuse = false;
      return false;
    }
  }

  async init(): Promise<void> {
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.doInit();
    return this.initPromise;
  }

  private async doInit(): Promise<void> {
    await this.store.open();
    for (const seed of getTrustSeeds()) this.addNode(seed);

    const catalog = await this.store.list(LOCAL_NODE_CONSTANTS.STORE_RELOAD_LIMIT);
    for (const doc of catalog) {
      if (LOCAL_NODE_CONSTANTS.BAD_NODE_VERSIONS.includes(doc.version ?? "")) continue;
      this.addNode(doc);
    }

    const notInited = this.nodes.filter((n) => !n.inited);
    const batch = notInited.slice(0, LOCAL_NODE_CONSTANTS.INI_NODE_COUNT);
    await Promise.all(batch.map((n) => this.probeNode(n)));

    // Ensure we have at least a few canuse nodes — probe more if needed.
    let usable = this.canuseNodes().length;
    let offset = LOCAL_NODE_CONSTANTS.INI_NODE_COUNT;
    while (
      usable < LOCAL_NODE_CONSTANTS.MIN_NODES_COUNT &&
      offset < this.nodes.length
    ) {
      const next = this.nodes.slice(offset, offset + 3);
      offset += 3;
      await Promise.all(next.map((n) => this.probeNode(n)));
      usable = this.canuseNodes().length;
    }

    await this.persistCatalog();
    this.selectbest();
    this.ready = true;
    this.suspended = false;
    this.lastTouch = this.now();
    this.startBestapply();
  }

  private async persistCatalog(): Promise<void> {
    const docs = this.nodes
      .filter((n) => n.inited)
      .map((n) => n.export() as { key: string } & SeedMeta);
    await this.store.upsertMany(docs);
  }

  private startBestapply(): void {
    this.stopBestapply();
    this.bestapplyTimer = setInterval(() => {
      if (this.suspended) return;
      if (this.now() - this.lastTouch > LOCAL_NODE_CONSTANTS.IDLE_SUSPEND_MS) {
        this.suspend();
        return;
      }
      this.selectbest();
    }, LOCAL_NODE_CONSTANTS.BESTAPPLY_INTERVAL_MS);
  }

  private stopBestapply(): void {
    if (this.bestapplyTimer) {
      clearInterval(this.bestapplyTimer);
      this.bestapplyTimer = null;
    }
  }

  touch(): void {
    this.lastTouch = this.now();
  }

  suspend(): void {
    this.suspended = true;
    this.stopBestapply();
  }

  async ensureActive(): Promise<void> {
    this.touch();
    if (!this.ready) await this.init();
    if (this.suspended) {
      this.suspended = false;
      this.startBestapply();
    }
  }

  isReady(): boolean {
    return this.ready && this.canuseNodes().length > 0;
  }

  async waitreadywithrating(timeoutMs = LOCAL_NODE_CONSTANTS.WAIT_READY_MS): Promise<boolean> {
    const start = this.now();
    while (this.now() - start < timeoutMs) {
      if (this.canuseNodes().some((n) => n.rating() > 0 || n.canuse)) return true;
      await new Promise((r) => setTimeout(r, LOCAL_NODE_CONSTANTS.WAIT_READY_INTERVAL_MS));
    }
    return this.canuseNodes().length > 0;
  }

  async requestRpc(
    node: LocalNode,
    method: string,
    parameters: unknown[] = [],
    rpcOpts?: { timeout?: number; path?: "/public/" | "/post/" },
  ): Promise<unknown> {
    const path =
      rpcOpts?.path ??
      pathForRpcMethod(method) ??
      (method === "getnodeinfo" ? "/public/" : null);
    if (!path) {
      throw { code: -32601, message: "methodnotallowed" };
    }
    const port = this.tls ? node.sport : node.port;
    const url =
      path === "/post/"
        ? buildPostUrl(node.host, port, this.tls)
        : buildPublicUrl(node.host, port, this.tls);
    const started = this.now();
    const params = Array.isArray(parameters) ? parameters : [parameters];
    const body = buildJsonRpcBody(method, params, this.rpcId++);

    try {
      const raw = await localNodeRequest({
        url,
        method: "POST",
        body,
        timeout: rpcOpts?.timeout ?? LOCAL_NODE_CONSTANTS.DEFAULT_RPC_TIMEOUT_MS,
      });
      const result = unwrapJsonRpc(raw);
      node.recordRpcResult({
        success: true,
        code: 200,
        time: Math.max(0, this.now() - started),
        method,
      });
      return result;
    } catch (err) {
      const mapped = mapTransportError(err);
      node.recordRpcResult({
        success: false,
        code: mapped.code || 408,
        time: Math.max(0, this.now() - started),
        method,
      });
      throw mapped;
    }
  }

  /**
   * Lightweight peer discovery via getpeerinfo on one canuse node.
   */
  async discoverPeers(): Promise<number> {
    const source = this.selectbest();
    if (!source) return 0;
    let added = 0;
    try {
      const peers = (await this.requestRpc(source, "getpeerinfo", [])) as Array<{
        addr?: string;
      }>;
      if (!Array.isArray(peers)) return 0;
      const candidates = peers
        .map((p) => p.addr)
        .filter((a): a is string => typeof a === "string" && !a.includes(".i2p"))
        .slice(0, LOCAL_NODE_CONSTANTS.DISCOVERY_PEER_ASK_BATCH);

      for (const addr of candidates) {
        const host = addr.split(":")[0];
        if (!host || this.nodesmap[`${host}:${LOCAL_NODE_CONSTANTS.WEB_PORT}`]) continue;
        const node = this.addNode({
          host,
          port: LOCAL_NODE_CONSTANTS.WEB_PORT,
          sport: LOCAL_NODE_CONSTANTS.SECURE_WEB_PORT,
          ws: LOCAL_NODE_CONSTANTS.WS_PORT,
          sws: LOCAL_NODE_CONSTANTS.SECURE_WS_PORT,
          name: host,
          peer: true,
          addedby: source.key,
          allowRpc: true,
        });
        const ok = await this.probeNode(node);
        if (ok) added += 1;
        if (added >= LOCAL_NODE_CONSTANTS.DISCOVERY_ASK_SUCCESS_CAP) break;
      }
      await this.persistCatalog();
    } catch {
      /* discovery is best-effort */
    }
    return added;
  }

  async destroy(): Promise<void> {
    this.suspend();
    await this.store.close();
    this.nodes = [];
    this.nodesmap = {};
    this.ready = false;
    this.initPromise = null;
  }
}
