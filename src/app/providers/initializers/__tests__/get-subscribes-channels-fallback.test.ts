import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resetNodeFailover } from "@/shared/lib/pocketnet";

/**
 * WEE-13 — bastyon subscriptions must survive a blocked/dying proxy node.
 *
 * `getSubscribesChannels` goes through the centralized failover client
 * (`callPocketnetRpc`), so when the first gateway returns 503 the request must
 * rotate to the next mirror instead of failing outright — that is the whole
 * fix for blocked-region users (RU/CIS ISP filtering of `1.pocketnet.app`).
 * These tests run the REAL failover chain against a stubbed global fetch.
 */

// Avoid loading the heavy Bastyon chat-scripts / SDK config in the test env,
// but keep a two-mirror proxy list so the failover chain has somewhere to go.
vi.mock("../../chat-scripts", () => ({
  PocketnetInstanceConfigurator: { setTimeDifference: vi.fn() },
}));
vi.mock("../../chat-scripts/config/pocketnetinstance", () => ({
  PocketnetInstance: {
    options: {
      listofproxies: [
        { host: "1.pocketnet.app", port: 8899 },
        { host: "2.pocketnet.app", port: 8899 },
      ],
    },
  },
}));

import { createAppInitializer } from "../app-initializer";

function jsonResponse(status: number, body: unknown = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe("AppInitializer.getSubscribesChannels — proxy fallback chain (WEE-13)", () => {
  beforeEach(() => {
    resetNodeFailover();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("tries the next proxy when the first returns 503", async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(503))
      .mockResolvedValueOnce(
        jsonResponse(200, {
          data: { channels: [{ address: "abc", name: "Test" }], height: 100 },
        })
      );
    vi.stubGlobal("fetch", fetchSpy);

    const result = await createAppInitializer().getSubscribesChannels("addr1");

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(String(fetchSpy.mock.calls[0][0])).toContain("https://1.pocketnet.app:8899");
    expect(String(fetchSpy.mock.calls[1][0])).toContain("https://2.pocketnet.app:8899");
    expect(result?.channels[0].address).toBe("abc");
    expect(result?.height).toBe(100);
  });

  it("does not pin a hardcoded backend node (no options.node in the body)", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse(200, { data: { channels: [], height: 1 } })
    );
    vi.stubGlobal("fetch", fetchSpy);

    await createAppInitializer().getSubscribesChannels("addr1", 0, 0, 20);

    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect(body.method).toBe("getsubscribeschannels");
    expect(body.parameters).toEqual(["addr1", 0, 0, 20]);
    expect(body.options).toBeUndefined();
  });

  it("returns undefined when every proxy fails — so the store can show error UI", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse(503));
    vi.stubGlobal("fetch", fetchSpy);

    const result = await createAppInitializer().getSubscribesChannels("addr1");

    expect(fetchSpy).toHaveBeenCalledTimes(2); // both mirrors tried
    expect(result).toBeUndefined();
  });

  it("returns undefined on an RPC-level error envelope", async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { error: { code: -1, message: "boom" } }));
    vi.stubGlobal("fetch", fetchSpy);

    const result = await createAppInitializer().getSubscribesChannels("addr1");

    expect(result).toBeUndefined();
  });
});
