/**
 * Parallel gateway health race + Local Node Proxy ping (donor softping /
 * wait.ready + directdialog gate).
 *
 * Decision window ≠ request abort: after {@link PROXY_OFFER_DECISION_MS} we
 * evaluate whether to offer Local; gateway pings keep their own longer timeout
 * and may still win later (late winner / dialog dismiss).
 */

/** When to decide Local offer if no remote has answered yet. */
export const PROXY_OFFER_DECISION_MS = 4_000;

/** Per-gateway getnodeinfo ceiling — do not tie to the offer decision window. */
export const PROXY_GATEWAY_PING_TIMEOUT_MS = 10_000;

/** @deprecated Prefer {@link PROXY_OFFER_DECISION_MS}. */
export const PROXY_RACE_BUDGET_MS = PROXY_OFFER_DECISION_MS;

export interface GatewayPingResult {
  url: string;
  ok: boolean;
  error?: string;
}

export interface RaceGatewaysResult {
  /** First gateway that answered by the time the decision promise resolves. */
  winner: string | null;
  results: GatewayPingResult[];
}

export interface PingGatewayOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  nowMs?: () => number;
  /**
   * Fired when a gateway succeeds after the decision promise already resolved
   * with no winner (in-flight request completed late).
   */
  onLateWinner?: (url: string) => void;
}

async function fetchWithDeadline(
  doFetch: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller?.abort();
      reject(new Error(`timeout after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  const request = doFetch(url, controller ? { ...init, signal: controller.signal } : init);
  request.catch(() => undefined);
  try {
    return await Promise.race([request, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** POST getnodeinfo to a gateway base URL (`https://host:8899`). */
export async function pingGateway(
  baseUrl: string,
  opts: PingGatewayOptions = {},
): Promise<GatewayPingResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? PROXY_GATEWAY_PING_TIMEOUT_MS;
  const url = `${baseUrl.replace(/\/+$/, "")}/rpc/getnodeinfo`;
  try {
    const res = await fetchWithDeadline(
      doFetch,
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ method: "getnodeinfo", parameters: [] }),
      },
      timeoutMs,
    );
    if (!res.ok) {
      return { url: baseUrl, ok: false, error: `HTTP ${res.status}` };
    }
    await res.json().catch(() => ({}));
    return { url: baseUrl, ok: true };
  } catch (e) {
    return {
      url: baseUrl,
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/**
 * Ping all gateways in parallel. Resolves at `decisionMs` (or earlier on first
 * success / all settled). In-flight pings are **not** aborted at decision time —
 * a late success calls `opts.onLateWinner`.
 */
export async function raceGateways(
  urls: readonly string[],
  decisionMs: number = PROXY_OFFER_DECISION_MS,
  opts: PingGatewayOptions = {},
): Promise<RaceGatewaysResult> {
  if (urls.length === 0) {
    return { winner: null, results: [] };
  }

  const pingTimeout = opts.timeoutMs ?? PROXY_GATEWAY_PING_TIMEOUT_MS;
  const results: GatewayPingResult[] = [];
  let winner: string | null = null;

  await new Promise<void>((resolve) => {
    let settled = 0;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };

    const decisionTimer = setTimeout(finish, decisionMs);

    for (const base of urls) {
      void pingGateway(base, { ...opts, timeoutMs: pingTimeout }).then((r) => {
        results.push(r);
        if (r.ok) {
          if (winner == null) {
            winner = r.url;
            if (done) {
              opts.onLateWinner?.(r.url);
            }
          }
        }
        settled += 1;
        if (winner != null || settled >= urls.length) {
          clearTimeout(decisionTimer);
          finish();
        }
      });
    }
  });

  return { winner, results };
}

export interface PingLocalOptions {
  ping?: () => Promise<boolean>;
  timeoutMs?: number;
}

/**
 * Local readiness sample for the offer decision window.
 * Does not abort Local Node init — only bounds how long we wait to say "ready".
 */
export async function pingLocal(opts: PingLocalOptions = {}): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? PROXY_OFFER_DECISION_MS;
  const ping =
    opts.ping ??
    (async () => {
      const { getSharedLocalNodeProxy } = await import("./local-node");
      return getSharedLocalNodeProxy().ping(timeoutMs);
    });

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      ping().catch(() => false),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
