import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  isRetriableNodeStatus,
  buildNodeBaseUrls,
  rpcFetchWithFailover,
  resetNodeFailover,
} from "../node-failover";

/** Minimal fake Response for an injected fetch. */
function fakeResponse(status: number, json: unknown = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => json,
  } as unknown as Response;
}

const NODES = [
  "https://1.pocketnet.app:8899",
  "https://2.pocketnet.app:8899",
  "https://6.pocketnet.app:8899",
];

describe("isRetriableNodeStatus", () => {
  it("treats gateway/unavailable/timeout/rate-limit/network as retriable", () => {
    for (const s of [0, 429, 502, 503, 504]) expect(isRetriableNodeStatus(s)).toBe(true);
  });
  it("treats success and client errors as non-retriable", () => {
    for (const s of [200, 400, 401, 403, 404, 500]) expect(isRetriableNodeStatus(s)).toBe(false);
  });
});

describe("buildNodeBaseUrls", () => {
  it("maps proxy host/port to https base URLs", () => {
    expect(
      buildNodeBaseUrls([
        { host: "1.pocketnet.app", port: 8899 },
        { host: "2.pocketnet.app", port: 8899 },
      ])
    ).toEqual(["https://1.pocketnet.app:8899", "https://2.pocketnet.app:8899"]);
  });
  it("falls back to node 1 when the list is empty/null", () => {
    expect(buildNodeBaseUrls([])).toEqual(["https://1.pocketnet.app:8899"]);
    expect(buildNodeBaseUrls(null)).toEqual(["https://1.pocketnet.app:8899"]);
    expect(buildNodeBaseUrls(undefined)).toEqual(["https://1.pocketnet.app:8899"]);
  });
});

describe("rpcFetchWithFailover", () => {
  beforeEach(() => {
    resetNodeFailover();
    vi.restoreAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("returns the first node's JSON when it is healthy", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      fakeResponse(200, { data: { height: 42 } })
    );
    const json = await rpcFetchWithFailover("/rpc/getnodeinfo", { method: "getnodeinfo" }, {
      nodes: NODES,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      startIndex: 0,
    });
    expect(json).toEqual({ data: { height: 42 } });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toBe("https://1.pocketnet.app:8899/rpc/getnodeinfo");
  });

  it("rotates to the next node on a 502 and returns its JSON", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(fakeResponse(502))
      .mockResolvedValueOnce(fakeResponse(200, { ok: true }));
    const json = await rpcFetchWithFailover("/rpc/getprofilefeed", {}, {
      nodes: NODES,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      startIndex: 0,
    });
    expect(json).toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[1][0]).toBe("https://2.pocketnet.app:8899/rpc/getprofilefeed");
  });

  it("rotates on a network error (thrown fetch)", async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockResolvedValueOnce(fakeResponse(200, { ok: 1 }));
    const json = await rpcFetchWithFailover("/rpc/x", {}, {
      nodes: NODES,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      startIndex: 0,
    });
    expect(json).toEqual({ ok: 1 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("throws an aggregate error when every node returns 502", async () => {
    const fetchImpl = vi.fn(async () => fakeResponse(502));
    await expect(
      rpcFetchWithFailover("/rpc/x", {}, {
        nodes: NODES,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        startIndex: 0,
      })
    ).rejects.toThrow(/all nodes failed/);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("stops early on a non-retriable client error (does not try other nodes)", async () => {
    const fetchImpl = vi.fn(async () => fakeResponse(400));
    await expect(
      rpcFetchWithFailover("/rpc/x", {}, {
        nodes: NODES,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        startIndex: 0,
      })
    ).rejects.toThrow(/non-retriable HTTP 400/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("cuts off a node after a 502 so the NEXT call skips straight to a healthy one", async () => {
    const T = 1_000;
    // Call 1: node 0 → 502 (cut off), node 1 → 200.
    const call1 = vi
      .fn()
      .mockResolvedValueOnce(fakeResponse(502))
      .mockResolvedValueOnce(fakeResponse(200, { ok: 1 }));
    await rpcFetchWithFailover("/rpc/x", {}, {
      nodes: NODES,
      fetchImpl: call1 as unknown as typeof fetch,
      startIndex: 0,
      nowMs: T,
    });

    // Call 2 within the cooldown window, again starting at index 0: node 0 is
    // cut off, so the first request must go to node 1 — not node 0.
    const call2 = vi.fn(async (_url: string, _init?: RequestInit) => fakeResponse(200, { ok: 2 }));
    await rpcFetchWithFailover("/rpc/x", {}, {
      nodes: NODES,
      fetchImpl: call2 as unknown as typeof fetch,
      startIndex: 0,
      nowMs: T + 5_000, // still < cooldown
    });
    expect(call2.mock.calls[0][0]).toBe("https://2.pocketnet.app:8899/rpc/x");
  });

  it("retries a cut-off node once the cooldown has elapsed", async () => {
    const T = 1_000;
    const call1 = vi
      .fn()
      .mockResolvedValueOnce(fakeResponse(502))
      .mockResolvedValueOnce(fakeResponse(200, { ok: 1 }));
    await rpcFetchWithFailover("/rpc/x", {}, {
      nodes: NODES,
      fetchImpl: call1 as unknown as typeof fetch,
      startIndex: 0,
      nowMs: T,
      cooldownMs: 30_000,
    });

    // After cooldown, node 0 is healthy again and tried first.
    const call2 = vi.fn(async (_url: string, _init?: RequestInit) => fakeResponse(200, { ok: 2 }));
    await rpcFetchWithFailover("/rpc/x", {}, {
      nodes: NODES,
      fetchImpl: call2 as unknown as typeof fetch,
      startIndex: 0,
      nowMs: T + 30_001,
      cooldownMs: 30_000,
    });
    expect(call2.mock.calls[0][0]).toBe("https://1.pocketnet.app:8899/rpc/x");
  });

  it("still attempts a cut-off node when every node is in cooldown (never hard-fails on cooldown alone)", async () => {
    const T = 1_000;
    // Cut every node off via an all-502 call.
    const seed = vi.fn(async (_url: string, _init?: RequestInit) => fakeResponse(502));
    await expect(
      rpcFetchWithFailover("/rpc/x", {}, {
        nodes: NODES,
        fetchImpl: seed as unknown as typeof fetch,
        startIndex: 0,
        nowMs: T,
      })
    ).rejects.toThrow(/all nodes failed/);

    // Next call still within cooldown: all nodes are cut off, but the call must
    // still try them (deprioritized) rather than refuse outright.
    const recover = vi.fn(async (_url: string, _init?: RequestInit) => fakeResponse(200, { ok: 1 }));
    const json = await rpcFetchWithFailover("/rpc/x", {}, {
      nodes: NODES,
      fetchImpl: recover as unknown as typeof fetch,
      startIndex: 0,
      nowMs: T + 1_000,
    });
    expect(json).toEqual({ ok: 1 });
    expect(recover).toHaveBeenCalledTimes(1);
  });

  it("aborts a hung node after timeoutMs and fails over to the next (WEE-13)", async () => {
    // Node 1 emulates a blackholed host: the fetch never settles on its own,
    // it only rejects when the failover's deadline aborts it.
    const hungFetch = (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("The operation was aborted.", "AbortError"))
        );
      });
    const fetchImpl = vi
      .fn()
      .mockImplementationOnce(hungFetch)
      .mockResolvedValueOnce(fakeResponse(200, { data: { channels: [] } }));

    const json = await rpcFetchWithFailover("/rpc/getsubscribeschannels", {}, {
      nodes: NODES,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      startIndex: 0,
      timeoutMs: 30,
    });

    expect(json).toEqual({ data: { channels: [] } });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[1][0]).toBe("https://2.pocketnet.app:8899/rpc/getsubscribeschannels");
  });

  it("enforces the deadline even when fetch ignores the abort signal (old WebViews)", async () => {
    // Node 1 hangs AND has no AbortController support — the promise never
    // settles regardless of the signal. The Promise.race deadline must still
    // advance the loop to node 2.
    const fetchImpl = vi
      .fn()
      .mockImplementationOnce(() => new Promise<Response>(() => { /* never settles */ }))
      .mockResolvedValueOnce(fakeResponse(200, { ok: 1 }));

    const json = await rpcFetchWithFailover("/rpc/x", {}, {
      nodes: NODES,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      startIndex: 0,
      timeoutMs: 30,
    });

    expect(json).toEqual({ ok: 1 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("tags timed-out nodes as timeouts in the aggregate error", async () => {
    const fetchImpl = vi.fn(() => new Promise<Response>(() => { /* never settles */ }));
    await expect(
      rpcFetchWithFailover("/rpc/x", {}, {
        nodes: NODES,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        startIndex: 0,
        timeoutMs: 20,
      })
    ).rejects.toThrow(/timeout after 20ms/);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("passes an abort signal to fetch so the deadline is enforceable", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return fakeResponse(200, { ok: 1 });
    });
    await rpcFetchWithFailover("/rpc/x", {}, {
      nodes: NODES,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      startIndex: 0,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("remembers the last healthy node (sticky) for the next call", async () => {
    const fetchImpl = vi
      .fn()
      // call 1: node 0 → 502, node 1 → 200 (sticky becomes idx 1)
      .mockResolvedValueOnce(fakeResponse(502))
      .mockResolvedValueOnce(fakeResponse(200, { n: 1 }))
      // call 2: should start at node 1 directly
      .mockResolvedValueOnce(fakeResponse(200, { n: 2 }));

    await rpcFetchWithFailover("/rpc/x", {}, {
      nodes: NODES,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      startIndex: 0,
    });
    // No startIndex → uses sticky (now idx 1)
    await rpcFetchWithFailover("/rpc/x", {}, {
      nodes: NODES,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(fetchImpl.mock.calls[2][0]).toBe("https://2.pocketnet.app:8899/rpc/x");
  });
});
