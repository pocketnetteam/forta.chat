/**
 * Route SDK blockchain RPC through {@link callPocketnetRpc} so Networking Local /
 * gateway sticky apply to Api.rpc / psdk.userInfo / wallet / getmissedinfo.
 *
 * Does not touch Proxy16.fetch (ping, nodes/*, peertubeserversList).
 *
 * Vendor api.js keeps Proxy16 in a module closure (`new Proxy16` ≠ window.Proxy16),
 * so the reliable hook is wrapping the Api instance `.rpc`. We also bridge any
 * Proxy16 instances we can reach and wrap window.Proxy16 for external callers.
 */

import { callPocketnetRpc, unwrapRpcPayload } from "./node-rpc-client";

const API_FLAG = "__fortaSdkApiRpcBridged";
const CTOR_FLAG = "__fortaSdkRpcCtorBridged";
const INST_FLAG = "__fortaSdkRpcBridged";

export type SdkRpcBridgeCall = typeof callPocketnetRpc;

export interface SdkRpcBridgeDeps {
  callRpc?: SdkRpcBridgeCall;
  getProxy16?: () => Proxy16Constructor | null | undefined;
}

type RpcFn = (
  method: string,
  parameters?: unknown[],
  options?: Record<string, unknown> | null,
  trying?: number,
) => Promise<unknown>;

type Proxy16Instance = {
  rpc?: RpcFn;
  [INST_FLAG]?: boolean;
};

type ApiLike = {
  rpc?: RpcFn;
  get?: { proxies?: () => Proxy16Instance[] };
  [API_FLAG]?: boolean;
};

type Proxy16Constructor = (new (
  meta?: unknown,
  app?: unknown,
  api?: unknown,
) => Proxy16Instance) & {
  [CTOR_FLAG]?: boolean;
  prototype?: object;
};

function normalizeRpcError(e: unknown): never {
  if (e && typeof e === "object") {
    const err = e as { code?: unknown };
    if (typeof err.code !== "number") {
      (err as { code: number }).code = 0;
    }
    throw err;
  }
  throw { code: 0, message: e instanceof Error ? e.message : String(e) };
}

function resolveNode(options: Record<string, unknown> | null | undefined): string | undefined {
  if (!options) return undefined;
  if (typeof options.fnode === "string" && options.fnode) return options.fnode;
  if (typeof options.node === "string" && options.node) return options.node;
  return undefined;
}

async function invokeBridgedRpc(
  callRpc: SdkRpcBridgeCall,
  method: string,
  parameters: unknown[] = [],
  options: Record<string, unknown> | null = {},
): Promise<unknown> {
  if (!method) return Promise.reject("method");
  try {
    const opts = options && typeof options === "object" ? options : {};
    // Api.rpc passes options.rpc through to Proxy16.rpc — unwrap that nest.
    const rpcOpts =
      opts.rpc && typeof opts.rpc === "object"
        ? (opts.rpc as Record<string, unknown>)
        : opts;
    const envelope = await callRpc({
      method,
      parameters: Array.isArray(parameters) ? parameters : [],
      node: resolveNode(rpcOpts),
      endpoint: rpcOpts.ex ? "rpc-ex" : "rpc",
    });
    return unwrapRpcPayload(envelope);
  } catch (e) {
    normalizeRpcError(e);
  }
}

/**
 * Replace one Proxy16 instance `.rpc` with a callPocketnetRpc bridge.
 * Idempotent per instance.
 */
export function bridgeProxy16Instance(
  proxy: Proxy16Instance | null | undefined,
  deps: SdkRpcBridgeDeps = {},
): boolean {
  if (!proxy || typeof proxy !== "object") return false;
  if (proxy[INST_FLAG]) return false;

  const callRpc = deps.callRpc ?? callPocketnetRpc;
  proxy[INST_FLAG] = true;
  proxy.rpc = (method, parameters, options) =>
    invokeBridgedRpc(callRpc, method, parameters, options);
  return true;
}

/** Bridge every reachable proxy on an Api instance (`get.proxies()`). */
export function bridgeApiProxies(
  api: ApiLike | null | undefined,
  deps: SdkRpcBridgeDeps = {},
): number {
  if (!api) return 0;
  let list: Proxy16Instance[] = [];
  try {
    if (typeof api.get?.proxies === "function") {
      list = api.get.proxies() ?? [];
    }
  } catch {
    list = [];
  }
  let n = 0;
  for (const p of list) {
    if (bridgeProxy16Instance(p, deps)) n += 1;
  }
  return n;
}

/**
 * Wrap Api.rpc — primary hook (Proxy16 ctor is closed over inside api.js).
 * Idempotent per Api instance.
 */
export function bridgeApiRpc(
  api: ApiLike | null | undefined,
  deps: SdkRpcBridgeDeps = {},
): boolean {
  if (!api || typeof api !== "object") return false;
  if (api[API_FLAG]) return false;

  const callRpc = deps.callRpc ?? callPocketnetRpc;
  api[API_FLAG] = true;
  api.rpc = (method, parameters, options) =>
    invokeBridgedRpc(callRpc, method, parameters, options);
  return true;
}

function resolveProxy16Ctor(
  deps: SdkRpcBridgeDeps,
): Proxy16Constructor | null {
  if (deps.getProxy16) {
    return deps.getProxy16() ?? null;
  }
  if (typeof window === "undefined") return null;
  try {
    const w = window as Window & { Proxy16?: Proxy16Constructor };
    return w.Proxy16 ?? null;
  } catch {
    return null;
  }
}

/** Best-effort wrap of window.Proxy16 for callers outside api.js closure. */
function installProxy16ConstructorBridge(deps: SdkRpcBridgeDeps): boolean {
  const Original = resolveProxy16Ctor(deps);
  if (!Original || Original[CTOR_FLAG]) return Boolean(Original?.[CTOR_FLAG]);

  const Bridged = function BridgedProxy16(
    this: Proxy16Instance,
    meta?: unknown,
    app?: unknown,
    api?: unknown,
  ): Proxy16Instance {
    const instance = new Original(meta, app, api);
    bridgeProxy16Instance(instance, deps);
    return instance;
  } as unknown as Proxy16Constructor;

  Bridged.prototype = Original.prototype;
  Object.setPrototypeOf(Bridged, Original);
  Bridged[CTOR_FLAG] = true;
  Original[CTOR_FLAG] = true;

  if (typeof window !== "undefined" && !deps.getProxy16) {
    try {
      (window as Window & { Proxy16?: Proxy16Constructor }).Proxy16 = Bridged;
    } catch {
      /* ignore */
    }
  }
  return true;
}

/**
 * Install SDK → callPocketnetRpc bridge.
 * Pass the live Api instance after `new Api(...)` so `.rpc` is wrapped.
 */
export function installSdkRpcBridge(
  api?: ApiLike | null,
  deps: SdkRpcBridgeDeps = {},
): boolean {
  installProxy16ConstructorBridge(deps);
  let ok = false;
  if (api) {
    if (bridgeApiRpc(api, deps)) ok = true;
    bridgeApiProxies(api, deps);
  }
  return ok || Boolean(resolveProxy16Ctor(deps)?.[CTOR_FLAG]);
}

/** Test helper — clear install flags on an api/proxy. */
export function resetSdkRpcBridgeForTests(
  target?: ApiLike | Proxy16Instance | null,
): void {
  if (target) {
    delete (target as ApiLike)[API_FLAG];
    delete (target as Proxy16Instance)[INST_FLAG];
  }
  if (typeof window === "undefined") return;
  try {
    const w = window as Window & { Proxy16?: Proxy16Constructor };
    if (w.Proxy16) delete w.Proxy16[CTOR_FLAG];
  } catch {
    /* ignore */
  }
}
