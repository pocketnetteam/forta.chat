/**
 * Dev-only CORS relay for Local Node Proxy browser testing.
 * Binds 127.0.0.1 only; forwards POST /public[/method] and /post[/method] to a node
 * identified by X-Node-Host / X-Node-Port / X-Node-TLS.
 * Optional method suffix is DevTools-only; upstream path is always /public/ or /post/.
 *
 * Contract (donor scripts/local-node-cors-relay.js):
 *   X-Node-Host  required (node hostname or IP)
 *   X-Node-Port  default 38081
 *   X-Node-TLS   "1" / "true" → https; else http
 *
 * Usage: npm run local-node-cors
 * Env:   LOCAL_NODE_CORS_PORT (default 18081)
 */
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_PORT = 18081;
export const DEFAULT_NODE_PORT = 38081;
export const BIND_HOST = "127.0.0.1";

/**
 * Map inbound request path → canonical node RPC path.
 * Accepts /public, /public/, /public/<method>, same for /post.
 */
export function canonicalizeRpcPath(requestPath) {
  const pathOnly = String(requestPath || "").split("?")[0];

  if (pathOnly === "/public" || pathOnly === "/public/") {
    return "/public/";
  }
  if (pathOnly === "/post" || pathOnly === "/post/") {
    return "/post/";
  }

  const m = pathOnly.match(/^\/(public|post)\/([a-zA-Z][a-zA-Z0-9_]*)$/);
  if (m) {
    return `/${m[1]}/`;
  }

  return null;
}

function normalizeHeaderMap(headers) {
  const out = {};
  if (!headers) return out;
  for (const k of Object.keys(headers)) {
    out[String(k).toLowerCase()] = headers[k];
  }
  return out;
}

function headerValue(headers, name) {
  const map = normalizeHeaderMap(headers);
  const v = map[String(name).toLowerCase()];
  if (Array.isArray(v)) return v[0];
  return v;
}

function isTruthyTls(value) {
  if (value == null) return false;
  const s = String(value).toLowerCase();
  return s === "1" || s === "true" || s === "yes";
}

/**
 * Pure helper: map inbound headers + path → upstream target URL parts.
 * @returns {{ ok: true, scheme: string, host: string, port: number, path: string, url: string } | { ok: false, status: number, message: string }}
 */
export function resolveTarget(headers, requestPath) {
  const rpcPath = canonicalizeRpcPath(requestPath);

  if (!rpcPath) {
    return {
      ok: false,
      status: 404,
      message: "path must be /public/ or /post/",
    };
  }

  let host = headerValue(headers, "x-node-host");
  if (host != null) host = String(host).trim();

  if (!host) {
    return { ok: false, status: 400, message: "missing X-Node-Host" };
  }

  // Open-proxy guard: host only (no scheme, userinfo, path, or port).
  if (
    /[/\\@:\s]/.test(host) ||
    (host !== "localhost" &&
      !/^\d{1,3}(\.\d{1,3}){3}$/.test(host) &&
      !/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i.test(host))
  ) {
    return { ok: false, status: 400, message: "invalid X-Node-Host" };
  }

  const portRaw = headerValue(headers, "x-node-port");
  const port =
    portRaw == null || portRaw === "" ? DEFAULT_NODE_PORT : Number(portRaw);

  if (!Number.isFinite(port) || port < 1 || port > 65535 || Math.floor(port) !== port) {
    return { ok: false, status: 400, message: "invalid X-Node-Port" };
  }

  const tls = isTruthyTls(headerValue(headers, "x-node-tls"));
  const scheme = tls ? "https" : "http";

  return {
    ok: true,
    scheme,
    host,
    port,
    path: rpcPath,
    url: `${scheme}://${host}:${port}${rpcPath}`,
  };
}

function corsHeaders(req) {
  const origin = (req && req.headers && req.headers.origin) || "*";
  return {
    "Access-Control-Allow-Origin": origin === "null" ? "*" : origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type, X-Node-Host, X-Node-Port, X-Node-TLS",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function writeJson(res, status, body, extraHeaders) {
  const payload = JSON.stringify(body);
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    ...(extraHeaders || {}),
  };
  res.writeHead(status, headers);
  res.end(payload);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function forwardToNode(target, body, timeoutMs = 55_000) {
  return new Promise((resolve, reject) => {
    const lib = target.scheme === "https" ? https : http;
    let timer;

    const req = lib.request(
      {
        protocol: `${target.scheme}:`,
        hostname: target.host,
        port: target.port,
        path: target.path,
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "Content-Length": body.length,
        },
        timeout: timeoutMs,
      },
      (upstream) => {
        const chunks = [];
        upstream.on("data", (chunk) => chunks.push(chunk));
        upstream.on("end", () => {
          if (timer) clearTimeout(timer);
          resolve({
            status: upstream.statusCode || 502,
            headers: upstream.headers || {},
            body: Buffer.concat(chunks),
          });
        });
      },
    );

    req.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });

    req.on("timeout", () => {
      req.destroy();
      reject(new Error("upstream timeout"));
    });

    timer = setTimeout(() => {
      req.destroy();
      reject(new Error("upstream timeout"));
    }, timeoutMs);

    req.write(body);
    req.end();
  });
}

export function createServer() {
  return http.createServer((req, res) => {
    let pathOnly = "/";
    const method = String(req.method || "GET").toUpperCase();
    const cors = corsHeaders(req);

    try {
      pathOnly = new URL(req.url || "/", "http://127.0.0.1").pathname || "/";
    } catch {
      pathOnly = String(req.url || "/").split("?")[0] || "/";
    }

    if (method === "OPTIONS") {
      res.writeHead(204, cors);
      res.end();
      return;
    }

    if (method !== "POST") {
      writeJson(res, 405, { message: "method not allowed" }, cors);
      return;
    }

    const target = resolveTarget(req.headers, pathOnly);
    if (!target.ok) {
      writeJson(res, target.status, { message: target.message }, cors);
      return;
    }

    readBody(req, 2 * 1024 * 1024)
      .then((body) => forwardToNode(target, body))
      .then((upstream) => {
        const headers = {
          ...cors,
          "Content-Type":
            (upstream.headers && upstream.headers["content-type"]) ||
            "application/json",
        };
        res.writeHead(upstream.status, headers);
        res.end(upstream.body);
      })
      .catch((err) => {
        const msg = (err && err.message) || "relay error";
        const status = msg === "body too large" ? 413 : 502;
        writeJson(res, status, { message: msg }, cors);
      });
  });
}

export function listen(options = {}) {
  const host = options.host || BIND_HOST;
  const port =
    options.port != null
      ? Number(options.port)
      : Number(process.env.LOCAL_NODE_CORS_PORT || DEFAULT_PORT);

  if (host !== "127.0.0.1" && host !== "localhost") {
    throw new Error(`local-node-cors-relay refuses non-localhost bind: ${host}`);
  }

  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    throw new Error(`invalid LOCAL_NODE_CORS_PORT: ${port}`);
  }

  const server = createServer();

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const addr = server.address();
      console.log(
        `[local-node-cors] listening http://${addr.address}:${addr.port}` +
          " (POST /public/|/post/ + X-Node-Host|Port|TLS)",
      );
      resolve(server);
    });
  });
}

const isMain =
  Boolean(process.argv[1]) &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  listen().catch((err) => {
    console.error(
      "[local-node-cors] failed:",
      err && err.message ? err.message : err,
    );
    process.exit(1);
  });
}
