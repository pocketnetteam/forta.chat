import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  bridgeApiRpc,
  bridgeProxy16Instance,
  installSdkRpcBridge,
  resetSdkRpcBridgeForTests,
} from "./sdk-rpc-bridge";

describe("sdk-rpc-bridge", () => {
  beforeEach(() => {
    resetSdkRpcBridgeForTests();
  });

  it("bridgeApiRpc routes through callPocketnetRpc and unwraps data", async () => {
    const callRpc = vi.fn(async () => ({ data: { name: "alice" } }));
    const api = {
      rpc: vi.fn(async () => {
        throw new Error("original should not run");
      }),
    };

    expect(bridgeApiRpc(api, { callRpc })).toBe(true);
    expect(bridgeApiRpc(api, { callRpc })).toBe(false); // idempotent

    const out = await api.rpc!("getuserprofile", [["P1"], "1"]);
    expect(out).toEqual({ name: "alice" });
    expect(callRpc).toHaveBeenCalledWith({
      method: "getuserprofile",
      parameters: [["P1"], "1"],
      node: undefined,
      endpoint: "rpc",
    });
  });

  it("maps options.ex / nested options.rpc to rpc-ex and node", async () => {
    const callRpc = vi.fn(async () => ({ result: 1 }));
    const api = { rpc: vi.fn() };
    bridgeApiRpc(api, { callRpc });

    await api.rpc!("getprofilefeed", [1], {
      rpc: { ex: true, node: "node-a" },
    });
    expect(callRpc).toHaveBeenCalledWith({
      method: "getprofilefeed",
      parameters: [1],
      node: "node-a",
      endpoint: "rpc-ex",
    });
  });

  it("bridgeProxy16Instance does not touch fetch", async () => {
    const callRpc = vi.fn(async () => ({ data: true }));
    const fetchFn = vi.fn(async () => ({ ok: true }));
    const proxy = {
      rpc: vi.fn(),
      fetch: fetchFn,
    };

    bridgeProxy16Instance(proxy, { callRpc });
    await proxy.rpc!("getnodeinfo", []);
    expect(callRpc).toHaveBeenCalled();

    await proxy.fetch!("ping", {}, { timeout: 4000 });
    expect(fetchFn).toHaveBeenCalledWith("ping", {}, { timeout: 4000 });
    expect(callRpc).toHaveBeenCalledTimes(1);
  });

  it("installSdkRpcBridge wraps the provided Api", async () => {
    const callRpc = vi.fn(async () => ({ data: "ok" }));
    const api = { rpc: vi.fn() };
    expect(installSdkRpcBridge(api, { callRpc })).toBe(true);
    await expect(api.rpc!("getaddressinfo", ["P"])).resolves.toBe("ok");
  });

  it("preserves error.code for SDK retry paths", async () => {
    const callRpc = vi.fn(async () => {
      throw { code: 408, message: "timeout" };
    });
    const api = { rpc: vi.fn() };
    bridgeApiRpc(api, { callRpc });
    await expect(api.rpc!("getnodeinfo")).rejects.toMatchObject({ code: 408 });
  });
});
