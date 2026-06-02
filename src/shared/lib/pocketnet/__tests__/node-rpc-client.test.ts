import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  configurePocketnetNodes,
  getConfiguredPocketnetNodes,
  callPocketnetRpc,
  unwrapRpcPayload,
} from "../node-rpc-client";
import { resetNodeFailover } from "../node-failover";

function fakeResponse(status: number, json: unknown = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => json,
  } as unknown as Response;
}

describe("configurePocketnetNodes / getConfiguredPocketnetNodes", () => {
  beforeEach(() => configurePocketnetNodes([]));

  it("returns the safe default (node 1) when unconfigured", () => {
    expect(getConfiguredPocketnetNodes()).toEqual(["https://1.pocketnet.app:8899"]);
  });

  it("returns the configured pool once set", () => {
    configurePocketnetNodes(["https://2.pocketnet.app:8899", "https://3.pocketnet.app:8899"]);
    expect(getConfiguredPocketnetNodes()).toEqual([
      "https://2.pocketnet.app:8899",
      "https://3.pocketnet.app:8899",
    ]);
  });
});

describe("unwrapRpcPayload", () => {
  it("prefers data, then result, then the envelope itself", () => {
    expect(unwrapRpcPayload({ data: { h: 1 } } as never)).toEqual({ h: 1 });
    expect(unwrapRpcPayload({ result: { h: 2 } } as never)).toEqual({ h: 2 });
    expect(unwrapRpcPayload({ h: 3 } as never)).toEqual({ h: 3 });
  });
});

describe("callPocketnetRpc", () => {
  const NODES = ["https://1.pocketnet.app:8899", "https://2.pocketnet.app:8899"];

  beforeEach(() => {
    resetNodeFailover();
    configurePocketnetNodes(NODES);
    vi.restoreAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("posts to /rpc/<method> with method + parameters and returns the envelope", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init?.body)) });
      return fakeResponse(200, { data: { height: 7 } });
    });
    // Inject fetch via global for this call path: callPocketnetRpc uses the
    // configured nodes + default fetch, so stub global fetch.
    vi.stubGlobal("fetch", fetchImpl);

    const envelope = await callPocketnetRpc<{ height?: number }>({
      method: "getnodeinfo",
      parameters: [],
    });

    expect(calls[0].url).toBe("https://1.pocketnet.app:8899/rpc/getnodeinfo");
    expect(calls[0].body).toEqual({ method: "getnodeinfo", parameters: [] });
    expect(unwrapRpcPayload(envelope).height).toBe(7);
    vi.unstubAllGlobals();
  });

  it("includes options.node only when a backend node is given", async () => {
    const bodies: unknown[] = [];
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return fakeResponse(200, { result: [] });
    });
    vi.stubGlobal("fetch", fetchImpl);

    await callPocketnetRpc({ method: "getprofilefeed", parameters: [1], node: "node-xyz" });
    expect(bodies[0]).toEqual({
      method: "getprofilefeed",
      parameters: [1],
      options: { node: "node-xyz" },
    });
    vi.unstubAllGlobals();
  });
});
