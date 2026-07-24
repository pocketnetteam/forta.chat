import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resetNodeFailover } from "@/shared/lib/pocketnet";

/**
 * getBlockHeight must not stampede pocketnet nodes during a DNS/outage:
 * concurrent callers share one in-flight promise, and a zero/failed result
 * cools down subsequent polls (~45s) so the 60s interval + WS reconnects
 * cannot pile up overlapping getnodeinfo failover chains.
 */

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

describe("AppInitializer.getBlockHeight — coalesce + cooldown", () => {
  beforeEach(() => {
    resetNodeFailover();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("coalesces concurrent callers onto a single in-flight fetch", async () => {
    let resolveFetch!: (v: Response) => void;
    const fetchSpy = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const init = createAppInitializer();
    const p1 = init.getBlockHeight();
    const p2 = init.getBlockHeight();

    expect(fetchSpy).toHaveBeenCalledTimes(1);

    resolveFetch(jsonResponse(200, { data: { height: 12345 } }));
    await expect(p1).resolves.toBe(12345);
    await expect(p2).resolves.toBe(12345);
  });

  it("cools down after all nodes fail — no immediate re-fetch", async () => {
    const fetchSpy = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    vi.stubGlobal("fetch", fetchSpy);

    const init = createAppInitializer();
    const first = await init.getBlockHeight();
    expect(first).toBe(0);
    const callsAfterFail = fetchSpy.mock.calls.length;
    expect(callsAfterFail).toBeGreaterThan(0);

    const second = await init.getBlockHeight();
    expect(second).toBe(0);
    expect(fetchSpy.mock.calls.length).toBe(callsAfterFail);
  });

  it("returns last known height during cooldown after a subsequent failure", async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { data: { height: 99 } }))
      .mockRejectedValue(new TypeError("Failed to fetch"));
    vi.stubGlobal("fetch", fetchSpy);

    const init = createAppInitializer();
    expect(await init.getBlockHeight()).toBe(99);

    // Failure arms cooldown; lastResult stays 99.
    expect(await init.getBlockHeight()).toBe(0);
    const calls = fetchSpy.mock.calls.length;

    expect(await init.getBlockHeight()).toBe(99);
    expect(fetchSpy.mock.calls.length).toBe(calls);
  });
});
