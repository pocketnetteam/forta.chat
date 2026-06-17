import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * WEE-65 (H3) — user search must work OUTSIDE the Bastyon WebView.
 *
 * The Bastyon SDK (`this.api`) only exists inside the Bastyon WebView; on
 * standalone Android / Electron the platform globals are undefined, so
 * `AppInitializer` runs with `_available = false`. The old `searchUsers` threw
 * `search_service_unavailable` in that mode and the user got an empty list with
 * no way to find anyone by nick. These tests pin the fix: standalone search
 * falls back to the centralized cross-node RPC client (`callPocketnetRpc`).
 */

// Spy for the centralized RPC failover client.
const mockCallPocketnetRpc = vi.fn();

vi.mock("@/shared/lib/pocketnet", () => ({
  configurePocketnetNodes: vi.fn(),
  buildNodeBaseUrls: vi.fn(() => []),
  callPocketnetRpc: (req: unknown) => mockCallPocketnetRpc(req),
  // Mirror the real envelope unwrap: data → result → body.
  unwrapRpcPayload: (envelope: { data?: unknown; result?: unknown }) =>
    envelope?.data ?? envelope?.result ?? envelope,
}));

// Avoid loading the heavy Bastyon chat-scripts / SDK config in the test env.
vi.mock("../chat-scripts", () => ({
  PocketnetInstanceConfigurator: { setTimeDifference: vi.fn() },
}));
vi.mock("../chat-scripts/config/pocketnetinstance", () => ({
  PocketnetInstance: { options: { listofproxies: null } },
}));

import { createAppInitializer } from "./app-initializer";

describe("AppInitializer.searchUsers — standalone RPC fallback (WEE-65 H3)", () => {
  beforeEach(() => {
    mockCallPocketnetRpc.mockReset();
  });

  it("falls back to callPocketnetRpc when the SDK is unavailable (standalone)", async () => {
    // Cyrillic name is URI-encoded by the backend; the mapper must decode it.
    mockCallPocketnetRpc.mockResolvedValue({
      data: [
        { address: "PTargetAddr12345678901234567890AB", name: "%D0%92%D0%B0%D1%81%D1%8F", i: "img-url" },
      ],
    });

    const init = createAppInitializer();
    const results = await init.searchUsers("вася");

    expect(mockCallPocketnetRpc).toHaveBeenCalledWith({
      method: "searchusers",
      parameters: ["вася", "users"],
    });
    expect(results).toEqual([
      { address: "PTargetAddr12345678901234567890AB", name: "Вася", image: "img-url" },
    ]);
  });

  it("drops records without an address and tolerates a non-array payload", async () => {
    mockCallPocketnetRpc.mockResolvedValue({
      data: [
        { address: "", name: "Ghost" },
        { address: "PValidAddr1234567890123456789012AB", name: "Real" },
      ],
    });

    const init = createAppInitializer();
    const results = await init.searchUsers("x");

    expect(results).toEqual([
      { address: "PValidAddr1234567890123456789012AB", name: "Real", image: "" },
    ]);
  });

  it("returns [] when the RPC payload is not an array", async () => {
    mockCallPocketnetRpc.mockResolvedValue({ data: { error: "nope" } });

    const init = createAppInitializer();
    const results = await init.searchUsers("x");

    expect(results).toEqual([]);
  });

  it("throws only when the fallback RPC fails (so callers can try Matrix/local tiers)", async () => {
    mockCallPocketnetRpc.mockRejectedValue(new Error("all nodes down"));

    const init = createAppInitializer();
    await expect(init.searchUsers("x")).rejects.toThrow("all nodes down");
  });
});

describe("AppInitializer.searchUsers — SDK-first then fallback (WEE-65 H3)", () => {
  beforeEach(() => {
    mockCallPocketnetRpc.mockReset();
    // Simulate the Bastyon WebView: platform globals exist, so the constructor
    // sets `_available = true` and the SDK path is tried first.
    vi.stubGlobal("Api", class {
      initIf() { return Promise.resolve(); }
      rpc() { throw new Error("sdk transport error"); }
    });
    vi.stubGlobal("Actions", class {
      init() { /* no-op */ }
    });
    vi.stubGlobal("pSDK", class {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("falls back to callPocketnetRpc when the SDK path throws", async () => {
    mockCallPocketnetRpc.mockResolvedValue({
      data: [{ address: "PFallbackAddr123456789012345678AB", name: "Fallback", i: "" }],
    });

    const init = createAppInitializer();
    const results = await init.searchUsers("q");

    expect(mockCallPocketnetRpc).toHaveBeenCalledWith({
      method: "searchusers",
      parameters: ["q", "users"],
    });
    expect(results).toEqual([
      { address: "PFallbackAddr123456789012345678AB", name: "Fallback", image: "" },
    ]);
  });
});
