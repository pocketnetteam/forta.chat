import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * blockchain-ws "transaction" events carry a `node` field — the node that
 * already indexed the incoming tx. Right after that event fires, a
 * round-robined txunspent call can still land on a DIFFERENT node that
 * hasn't caught up yet (replication lag) and report empty unspents even
 * though coins clearly arrived. checkUnspents pins its first attempt to that
 * hinted node, then falls back to the normal failover call on a miss — the
 * Actions SDK disables cross-node retry entirely once a node is pinned
 * (`fnode`), so a bad/stale hint must never be able to strand the caller.
 */

vi.mock("../../chat-scripts", () => ({
  PocketnetInstanceConfigurator: { setTimeDifference: vi.fn() },
}));
vi.mock("../../chat-scripts/config/pocketnetinstance", () => ({
  PocketnetInstance: { options: { listofproxies: null } },
}));

import { createAppInitializer } from "../app-initializer";

describe("AppInitializer.checkUnspents — WS node-pin with fallback", () => {
  let rpcCalls: Array<{ method: string; params: unknown; options: unknown }>;
  let rpcImpl: (method: string, params?: unknown, options?: unknown) => Promise<unknown>;

  beforeEach(() => {
    rpcCalls = [];
    vi.stubGlobal(
      "Api",
      class {
        initIf() { return Promise.resolve(); }
        wait = { ready: () => Promise.resolve() };
        ready = { use: true };
        rpc(method: string, params?: unknown, options?: unknown) {
          rpcCalls.push({ method, params, options });
          return rpcImpl(method, params, options);
        }
      },
    );
    vi.stubGlobal("Actions", class { init() {} });
    vi.stubGlobal("pSDK", class {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("without a hint, calls txunspent unpinned", async () => {
    rpcImpl = async () => [{ txid: "abc" }];
    const init = createAppInitializer();

    const result = await init.checkUnspents("PAddr1");

    expect(result).toBe(true);
    expect(rpcCalls).toEqual([
      { method: "txunspent", params: [["PAddr1"], 1, 9999999], options: undefined },
    ]);
  });

  it("with a hint, tries the pinned node first and returns without a fallback call on a hit", async () => {
    rpcImpl = async (_method, _params, options) => {
      expect(options).toEqual({ fnode: "node-42" });
      return [{ txid: "abc" }];
    };
    const init = createAppInitializer();

    const result = await init.checkUnspents("PAddr1", "node-42");

    expect(result).toBe(true);
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0].options).toEqual({ fnode: "node-42" });
  });

  it("falls back to the unpinned failover call when the pinned node still reports empty", async () => {
    let call = 0;
    rpcImpl = async (_method, _params, options) => {
      call++;
      if (call === 1) {
        expect(options).toEqual({ fnode: "stale-node" });
        return []; // pinned node hasn't caught up yet
      }
      expect(options).toBeUndefined();
      return [{ txid: "abc" }]; // normal failover node has it
    };
    const init = createAppInitializer();

    const result = await init.checkUnspents("PAddr1", "stale-node");

    expect(result).toBe(true);
    expect(rpcCalls).toHaveLength(2);
  });

  it("falls back to the unpinned call when the pinned node throws (bad/dead hint)", async () => {
    let call = 0;
    rpcImpl = async (_method, _params, options) => {
      call++;
      if (call === 1) {
        expect(options).toEqual({ fnode: "dead-node" });
        throw new Error("node unreachable");
      }
      expect(options).toBeUndefined();
      return [{ txid: "abc" }];
    };
    const init = createAppInitializer();

    const result = await init.checkUnspents("PAddr1", "dead-node");

    expect(result).toBe(true);
    expect(rpcCalls).toHaveLength(2);
  });

  it("returns false when both the pinned attempt and the fallback come up empty", async () => {
    rpcImpl = async () => [];
    const init = createAppInitializer();

    const result = await init.checkUnspents("PAddr1", "node-42");

    expect(result).toBe(false);
    expect(rpcCalls).toHaveLength(2);
  });
});
