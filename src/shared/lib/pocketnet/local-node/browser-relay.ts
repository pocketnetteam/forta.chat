/**
 * Browser → localhost CORS relay rewrite (donor LocalNodeTransport.buildBrowserRelay).
 * Native / Electron CapacitorHttp never uses this path.
 */

export const DEFAULT_LOCAL_NODE_CORS_RELAY = "http://127.0.0.1:18081";

export interface ParsedNodeRpcUrl {
  host: string;
  port: string;
  tls: boolean;
  rpcPath: "/public/" | "/post/";
}

export interface BrowserRelayTarget {
  url: string;
  headers: Record<string, string>;
  parsed: ParsedNodeRpcUrl;
}

export interface BrowserRelayEnv {
  isNative?: boolean;
  hostname?: string | null;
  /** Donor window.localNodeProxy — true forces on, false forces off. */
  forceLocalNodeProxy?: boolean | null;
  /** Donor window.localNodeCorsRelay / VITE_LOCAL_NODE_CORS_RELAY. */
  relayBase?: string | null;
}

function readWindowFlag(): boolean | null {
  if (typeof window === "undefined") return null;
  try {
    const w = window as Window & { localNodeProxy?: unknown };
    if (w.localNodeProxy === true) return true;
    if (w.localNodeProxy === false) return false;
  } catch {
    /* ignore */
  }
  return null;
}

function readWindowRelayBase(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const w = window as Window & { localNodeCorsRelay?: unknown };
    if (typeof w.localNodeCorsRelay === "string" && w.localNodeCorsRelay.trim()) {
      return w.localNodeCorsRelay.trim();
    }
  } catch {
    /* ignore */
  }
  return null;
}

function readViteRelayBase(): string | null {
  try {
    const env = (import.meta as ImportMeta & { env?: Record<string, string> }).env;
    const v = env?.VITE_LOCAL_NODE_CORS_RELAY;
    if (typeof v === "string" && v.trim()) return v.trim();
  } catch {
    /* ignore */
  }
  return null;
}

export function normalizeRelayBase(base: string): string {
  const s = String(base || "").trim();
  if (!s) return DEFAULT_LOCAL_NODE_CORS_RELAY;
  return s.replace(/\/+$/, "");
}

export function resolveRelayBase(env: BrowserRelayEnv = {}): string {
  if (env.relayBase != null && String(env.relayBase).trim()) {
    return normalizeRelayBase(String(env.relayBase));
  }
  const fromWindow = readWindowRelayBase();
  if (fromWindow) return normalizeRelayBase(fromWindow);
  const fromVite = readViteRelayBase();
  if (fromVite) return normalizeRelayBase(fromVite);
  return DEFAULT_LOCAL_NODE_CORS_RELAY;
}

/**
 * Whether browser requests may rewrite through the localhost CORS relay.
 * Native never uses the relay. Production web hosts stay off unless forced.
 */
export function shouldUseBrowserRelay(env: BrowserRelayEnv = {}): boolean {
  if (env.isNative === true) return false;

  if (env.forceLocalNodeProxy === true) return true;
  if (env.forceLocalNodeProxy === false) return false;

  const flag = readWindowFlag();
  if (flag === true) return true;
  if (flag === false) return false;

  let hostname = env.hostname;
  if (hostname === undefined) {
    if (typeof window === "undefined") {
      // Node unit tests: allow rewrite contract checks.
      return true;
    }
    try {
      hostname = window.location?.hostname ?? "";
    } catch {
      hostname = "";
    }
  }

  return hostname === "localhost" || hostname === "127.0.0.1";
}

/** Parse `http(s)://host:port/public/` or `/post/` node URL. */
export function parseNodeRpcUrl(nodeUrl: string): ParsedNodeRpcUrl | null {
  let u: URL;
  try {
    u = new URL(String(nodeUrl || ""));
  } catch {
    return null;
  }

  const path = u.pathname.replace(/\/+$/, "") + "/";
  let rpcPath: "/public/" | "/post/" | null = null;
  if (path === "/public/" || path.startsWith("/public/")) rpcPath = "/public/";
  else if (path === "/post/" || path.startsWith("/post/")) rpcPath = "/post/";
  if (!rpcPath) return null;

  const host = u.hostname;
  if (!host) return null;

  const port =
    u.port ||
    (u.protocol === "https:" ? "38881" : "38081");

  return {
    host,
    port,
    tls: u.protocol === "https:",
    rpcPath,
  };
}

export function sanitizeRpcMethodName(method: unknown): string {
  if (typeof method !== "string") return "";
  const m = method.trim();
  if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(m)) return "";
  return m;
}

/**
 * Browser → relay rewrite: node url → { url, headers }.
 * Optional rpcMethod is appended for DevTools only (/public/getnodeinfo).
 */
export function buildBrowserRelay(
  nodeUrl: string,
  opts: { base?: string | null; rpcMethod?: string | null; env?: BrowserRelayEnv } = {},
): BrowserRelayTarget | null {
  const parsed = parseNodeRpcUrl(nodeUrl);
  if (!parsed) return null;

  const relayBase = normalizeRelayBase(
    opts.base != null && String(opts.base).trim()
      ? String(opts.base)
      : resolveRelayBase(opts.env),
  );
  const suffix = sanitizeRpcMethodName(opts.rpcMethod);
  let url = `${relayBase}${parsed.rpcPath}`;
  if (suffix) url = `${url}${suffix}`;

  return {
    url,
    headers: {
      "X-Node-Host": parsed.host,
      "X-Node-Port": parsed.port,
      "X-Node-TLS": parsed.tls ? "1" : "0",
    },
    parsed,
  };
}

function rpcMethodFromBody(body: unknown): string {
  if (body == null) return "";
  if (typeof body === "string") {
    try {
      return rpcMethodFromBody(JSON.parse(body));
    } catch {
      return "";
    }
  }
  if (typeof body === "object" && body !== null && "method" in body) {
    return sanitizeRpcMethodName((body as { method?: unknown }).method);
  }
  return "";
}

/**
 * Apply relay rewrite for a browser TransportRequest, or return an error code.
 */
export function applyBrowserRelay(
  req: { url: string; body?: unknown; headers?: Record<string, string> },
  env: BrowserRelayEnv = {},
):
  | { ok: true; url: string; headers: Record<string, string> }
  | { ok: false; code: number; message: string } {
  if (!shouldUseBrowserRelay(env)) {
    return { ok: false, code: -1, message: "relaydisabled" };
  }

  const relay = buildBrowserRelay(req.url, {
    rpcMethod: rpcMethodFromBody(req.body),
    env,
  });
  if (!relay) {
    return { ok: false, code: -1, message: "badnodeurl" };
  }

  return {
    ok: true,
    url: relay.url,
    headers: { ...(req.headers ?? {}), ...relay.headers },
  };
}
