import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("@/shared/lib/pocketnet", () => ({
  configurePocketnetNodes: vi.fn(),
  buildNodeBaseUrls: vi.fn(() => []),
  callPocketnetRpc: vi.fn(),
  unwrapRpcPayload: (envelope: { data?: unknown; result?: unknown }) =>
    envelope?.data ?? envelope?.result ?? envelope,
}));

vi.mock("../chat-scripts", () => ({
  PocketnetInstanceConfigurator: { setTimeDifference: vi.fn() },
}));

const mockMyScoreLoad = vi.fn();

import { createAppInitializer } from "../app-initializer";
import { PocketnetInstance } from "../../chat-scripts/config/pocketnetinstance";

describe("AppInitializer.loadMyPostScore — batching via psdk.myScore.load", () => {
  beforeEach(() => {
    mockMyScoreLoad.mockReset();
    PocketnetInstance.user.address.value = "PTestUserAddrXXXXXXXXXXXXXXXXXXXX";

    vi.stubGlobal("Api", class {
      initIf() { return Promise.resolve(); }
      wait = { ready: () => Promise.resolve(true) };
      ready = { use: true };
      rpc() { return Promise.resolve({ time: 0 }); }
    });
    vi.stubGlobal("Actions", class {
      init() { /* no-op */ }
      prepare() { /* no-op */ }
    });
    vi.stubGlobal("pSDK", class {
      myScore = { load: mockMyScoreLoad };
      userInfo = { load: vi.fn(), get: vi.fn() };
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("coalesces concurrent per-post requests into a single myScore.load call", async () => {
    mockMyScoreLoad.mockResolvedValue({
      A: { posttxid: "A", value: 5 },
      B: { posttxid: "B", value: 3 },
      C: { posttxid: "C", value: 1 },
    });

    const init = createAppInitializer();
    const results = await Promise.all([
      init.loadMyPostScore("A"),
      init.loadMyPostScore("B"),
      init.loadMyPostScore("C"),
    ]);

    expect(mockMyScoreLoad).toHaveBeenCalledTimes(1);
    expect(mockMyScoreLoad).toHaveBeenCalledWith(["A", "B", "C"], [], false);
    expect(results).toEqual([5, 3, 1]);
  });

  it("deduplicates identical txids and fans the result out to every waiter", async () => {
    mockMyScoreLoad.mockResolvedValue({ A: { posttxid: "A", value: 7 } });

    const init = createAppInitializer();
    const results = await Promise.all([
      init.loadMyPostScore("A"),
      init.loadMyPostScore("A"),
      init.loadMyPostScore("A"),
    ]);

    expect(mockMyScoreLoad).toHaveBeenCalledTimes(1);
    expect(mockMyScoreLoad).toHaveBeenCalledWith(["A"], [], false);
    expect(results).toEqual([7, 7, 7]);
  });

  it("resolves null for posts with no score (empty record)", async () => {
    mockMyScoreLoad.mockResolvedValue({
      A: { posttxid: "A", value: 4 },
      B: {},
    });

    const init = createAppInitializer();
    const [a, b] = await Promise.all([
      init.loadMyPostScore("A"),
      init.loadMyPostScore("B"),
    ]);

    expect(a).toBe(4);
    expect(b).toBeNull();
  });

  it("forces a cache-bypassing batch when any request asks for update=true", async () => {
    mockMyScoreLoad.mockResolvedValue({ A: { posttxid: "A", value: 2 } });

    const init = createAppInitializer();
    await Promise.all([
      init.loadMyPostScore("A"),
      init.loadMyPostScore("A", undefined, true),
    ]);

    expect(mockMyScoreLoad).toHaveBeenCalledWith(["A"], [], true);
  });

  it("resolves null for all waiters when the batch call rejects", async () => {
    mockMyScoreLoad.mockRejectedValue(new Error("network"));

    const init = createAppInitializer();
    const results = await Promise.all([
      init.loadMyPostScore("A"),
      init.loadMyPostScore("B"),
    ]);

    expect(results).toEqual([null, null]);
  });

  it("resolves null without calling the SDK when psdk is unavailable", async () => {
    vi.stubGlobal("pSDK", undefined);

    const init = createAppInitializer();
    const result = await init.loadMyPostScore("A");

    expect(result).toBeNull();
    expect(mockMyScoreLoad).not.toHaveBeenCalled();
  });

  it("skips the getpagescores batch when no user is logged in", async () => {
    const prev = PocketnetInstance.user.address.value;
    PocketnetInstance.user.address.value = null;
    try {
      const init = createAppInitializer();
      const result = await init.loadMyPostScore("A");

      expect(result).toBeNull();
      expect(mockMyScoreLoad).not.toHaveBeenCalled();
    } finally {
      PocketnetInstance.user.address.value = prev;
    }
  });
});
