import { Capacitor, CapacitorHttp } from "@capacitor/core";
import { applyBrowserRelay } from "./browser-relay";
import { LOCAL_NODE_CONSTANTS } from "./constants";
import type { TransportError, TransportRequest } from "./types";

export function buildPublicUrl(host: string, port: number, tls: boolean): string {
  const scheme = tls ? "https" : "http";
  return `${scheme}://${host}:${port}/public/`;
}

export function buildPostUrl(host: string, port: number, tls: boolean): string {
  const scheme = tls ? "https" : "http";
  return `${scheme}://${host}:${port}/post/`;
}

export function buildJsonRpcBody(
  method: string,
  parameters: unknown[],
  id: number | string = 1,
): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    method,
    params: parameters,
    id,
  };
}

function rejectTransport(code: number, message: string): Promise<never> {
  const err: TransportError = { code, message };
  return Promise.reject(err);
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller?.abort();
      reject({ code: 408, message: `timeout after ${timeoutMs}ms` } satisfies TransportError);
    }, timeoutMs);
  });
  const request = fetchImpl(url, controller ? { ...init, signal: controller.signal } : init);
  request.catch(() => undefined);
  try {
    return await Promise.race([request, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

export interface LocalNodeRequestOptions {
  fetchImpl?: typeof fetch;
  /** Test override for Capacitor.isNativePlatform(). */
  isNative?: boolean;
  hostname?: string | null;
  forceLocalNodeProxy?: boolean | null;
  relayBase?: string | null;
}

/**
 * Prefer CapacitorHttp on native (no CORS). Browser/dev rewrites through the
 * localhost CORS relay (`npm run local-node-cors`). Production web hosts must
 * not enable Local without an explicit force flag.
 */
export async function localNodeRequest(
  req: TransportRequest,
  opts: LocalNodeRequestOptions = {},
): Promise<unknown> {
  const method = req.method ?? "POST";
  const timeoutMs = req.timeout ?? LOCAL_NODE_CONSTANTS.DEFAULT_RPC_TIMEOUT_MS;
  let headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json;charset=utf-8",
    ...(req.headers ?? {}),
  };
  const body =
    req.body == null
      ? undefined
      : typeof req.body === "string"
        ? req.body
        : JSON.stringify(req.body);

  const isNative =
    opts.isNative ??
    (typeof Capacitor !== "undefined" && Capacitor.isNativePlatform());

  if (isNative) {
    try {
      const response = await CapacitorHttp.request({
        url: req.url,
        method,
        headers,
        data: req.body ?? undefined,
        connectTimeout: timeoutMs,
        readTimeout: timeoutMs,
        disableRedirects: false,
      });
      if (response.status < 200 || response.status >= 300) {
        return rejectTransport(response.status, `HTTP ${response.status}`);
      }
      const data = response.data;
      if (typeof data === "string") {
        try {
          return JSON.parse(data);
        } catch {
          return data;
        }
      }
      return data;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return rejectTransport(0, message);
    }
  }

  const relay = applyBrowserRelay(
    { url: req.url, body: req.body, headers },
    {
      isNative: false,
      hostname: opts.hostname,
      forceLocalNodeProxy: opts.forceLocalNodeProxy,
      relayBase: opts.relayBase,
    },
  );
  if (!relay.ok) {
    return rejectTransport(relay.code, relay.message);
  }

  const url = relay.url;
  headers = relay.headers;

  try {
    const response = await fetchWithTimeout(
      url,
      { method, headers, body },
      timeoutMs,
      opts.fetchImpl ?? fetch,
    );
    if (!response.ok) {
      return rejectTransport(response.status, `HTTP ${response.status}`);
    }
    return await response.json();
  } catch (e) {
    if (e && typeof e === "object" && "code" in e) throw e;
    const message = e instanceof Error ? e.message : String(e);
    return rejectTransport(0, message);
  }
}

/**
 * Prefer cleartext :38081 by default — seed TLS (:38881) is often self-signed
 * and CapacitorHttp / Chromium cannot nocheck like Cordova's advanced-http.
 * Pass `tls: true` when a trusted cert or relay is available.
 */
export function resolveDefaultTls(force?: boolean): boolean {
  if (typeof force === "boolean") return force;
  return false;
}
