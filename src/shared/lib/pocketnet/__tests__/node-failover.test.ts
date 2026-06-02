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
