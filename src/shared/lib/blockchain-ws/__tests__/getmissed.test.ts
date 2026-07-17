import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  canRunGetMissed,
  fetchGetMissed,
  GETMISSED_MIN_INTERVAL_MS,
  markGetMissedRan,
  resetGetMissedThrottle,
} from "../getmissed";
import type { BlockchainWsRpcAdapter } from "../types";

function makeApi(rpcImpl: (m: string, p?: unknown[]) => Promise<unknown>): BlockchainWsRpcAdapter {
  return {
    rpc: vi.fn(rpcImpl) as unknown as BlockchainWsRpcAdapter["rpc"],
    get: {
      currentwss: vi.fn().mockResolvedValue({}) as unknown as BlockchainWsRpcAdapter["get"]["currentwss"],
    },
  };
}

describe("getmissed", () => {
  beforeEach(() => {
    resetGetMissedThrottle();
  });

  describe("canRunGetMissed", () => {
    it("always allows initial calls", () => {
      expect(canRunGetMissed(true)).toBe(true);
      markGetMissedRan(1_000);
      expect(canRunGetMissed(true, 1_010)).toBe(true);
    });

    it("rejects non-initial calls within the throttle window", () => {
      markGetMissedRan(1_000);
      expect(canRunGetMissed(false, 1_500)).toBe(false);
      expect(canRunGetMissed(false, 1_000 + GETMISSED_MIN_INTERVAL_MS - 1)).toBe(false);
    });

    it("allows non-initial calls once the window elapses", () => {
      markGetMissedRan(1_000);
      expect(canRunGetMissed(false, 1_000 + GETMISSED_MIN_INTERVAL_MS)).toBe(true);
    });
  });

  describe("fetchGetMissed", () => {
    it("returns null when address is empty", async () => {
      const api = makeApi(async () => null);
      const result = await fetchGetMissed({ api, address: "", fromBlock: 100 });
      expect(result).toBeNull();
      expect(api.rpc).not.toHaveBeenCalled();
    });

    it("returns null when fromBlock is zero/missing", async () => {
      const api = makeApi(async () => null);
      const result = await fetchGetMissed({ api, address: "addr", fromBlock: 0 });
      expect(result).toBeNull();
      expect(api.rpc).not.toHaveBeenCalled();
    });

    it("returns null on RPC error", async () => {
      const api = makeApi(async () => { throw new Error("net"); });
      const result = await fetchGetMissed({ api, address: "addr", fromBlock: 50 });
      expect(result).toBeNull();
    });

    it("returns null on empty response", async () => {
      const api = makeApi(async () => []);
      const result = await fetchGetMissed({ api, address: "addr", fromBlock: 50 });
      expect(result).toBeNull();
    });

    it("promotes the first item to a synthetic newblocks event", async () => {
      const api = makeApi(async () => [
        { block: 123, time: 999 },
      ]);
      const result = await fetchGetMissed({ api, address: "addr", fromBlock: 50 });
      expect(result).not.toBeNull();
      expect(result!.block.msg).toBe("newblocks");
      expect(result!.block.block).toBe(123);
      expect(result!.notifications).toEqual([]);
    });

    it("sorts notifications newest-first by nblock", async () => {
      const api = makeApi(async () => [
        { block: 100 },
        { txid: "old", nblock: 90 },
        { txid: "new", nblock: 99 },
        { txid: "mid", nblock: 95 },
      ]);
      const result = await fetchGetMissed({ api, address: "addr", fromBlock: 50 });
      expect(result!.notifications.map((n) => n.txid)).toEqual(["new", "mid", "old"]);
    });

    it("forwards the right args to the RPC layer", async () => {
      const rpc = vi.fn().mockResolvedValue([{ block: 1 }]);
      const api: BlockchainWsRpcAdapter = {
        rpc: rpc as unknown as BlockchainWsRpcAdapter["rpc"],
        get: {
          currentwss: vi.fn().mockResolvedValue({}) as unknown as BlockchainWsRpcAdapter["get"]["currentwss"],
        },
      };
      await fetchGetMissed({ api, address: "PA1", fromBlock: 77, limit: 50 });
      expect(rpc).toHaveBeenCalledWith("getmissedinfo", ["PA1", 77, 50]);
    });
  });
});
