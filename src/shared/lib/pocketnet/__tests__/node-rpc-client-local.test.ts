import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  callPocketnetRpc,
  configurePocketnetNodes,
  setPocketnetRpcRouter,
  unwrapRpcPayload,
} from "../node-rpc-client";
import { resetNodeFailover } from "../node-failover";

vi.mock("../local-node", () => ({
  getSharedLocalNodeProxy: () => ({
    rpc: vi.fn(async (method: string) => {
      if (method === "getnodeinfo") return { height: 42 };
      return [];
    }),
  }),
}));

describe("callPocketnetRpc local routing", () => {
  beforeEach(() => {
    resetNodeFailover();
    setPocketnetRpcRouter(null);
    configurePocketnetNodes(["https://1.pocketnet.app:8899"]);
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("uses Local Node Proxy when router.shouldUseLocal", async () => {
    setPocketnetRpcRouter({
      shouldUseLocal: () => true,
      allowLocalFallback: () => false,
      gatewayBaseUrls: () => ["https://1.pocketnet.app:8899"],
    });
    const envelope = await callPocketnetRpc<{ height: number }>({
      method: "getnodeinfo",
    });
    expect(unwrapRpcPayload(envelope)).toEqual({ height: 42 });
  });

  it("falls back to Local in auto when gateways fail", async () => {
    setPocketnetRpcRouter({
      shouldUseLocal: () => false,
      allowLocalFallback: () => true,
      gatewayBaseUrls: () => ["https://1.pocketnet.app:8899"],
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    const envelope = await callPocketnetRpc<{ height: number }>({
      method: "getnodeinfo",
    });
    expect(unwrapRpcPayload(envelope)).toEqual({ height: 42 });
    vi.unstubAllGlobals();
  });

  it("does not use Local when gatewaysOnly", async () => {
    setPocketnetRpcRouter({
      shouldUseLocal: () => true,
      allowLocalFallback: () => true,
      gatewayBaseUrls: () => ["https://1.pocketnet.app:8899"],
    });
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: { height: 9 } }),
    }));
    vi.stubGlobal("fetch", fetchImpl);
    const envelope = await callPocketnetRpc<{ height: number }>({
      method: "getnodeinfo",
      gatewaysOnly: true,
    });
    expect(unwrapRpcPayload(envelope).height).toBe(9);
    expect(fetchImpl).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
