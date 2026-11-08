import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resetNodeFailover } from "@/shared/lib/pocketnet";

/**
 * Boot blockchain calls wait for the Bastyon proxy ping and then go out
 * together; node time and block height share one getnodeinfo instead of two.
 */

const setTimeDifference = vi.fn();
vi.mock("../../chat-scripts", () => ({
  PocketnetInstanceConfigurator: { setTimeDifference: (d: number) => setTimeDifference(d) },
}));
vi.mock("../../chat-scripts/config/pocketnetinstance", () => ({
  PocketnetInstance: {
    options: { listofproxies: [{ host: "1.pocketnet.app", port: 8899 }] },
  },
}));
vi.mock("@/shared/lib/pocketnet", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/lib/pocketnet")>();
  return { ...actual, installSdkRpcBridge: vi.fn() };
});

const setArchived = vi.fn();
const loadArchivedDirect = vi.fn(async () => [] as string[]);
const hasFresh = vi.fn(() => false);
vi.mock("@/shared/lib/image-url", () => ({
  hasFreshArchivedPeertubeServers: () => hasFresh(),
  setArchivedPeertubeServers: (s: string[]) => setArchived(s),
  loadArchivedPeertubeServers: () => loadArchivedDirect(),
}));

import { createAppInitializer } from "../app-initializer";

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

function withFakeApi(opts: { ready?: boolean } = {}) {
  const init = createAppInitializer();
  const ping = deferred<void>();
  const api = {
    initIf: vi.fn(() => ping.promise),
    wait: { ready: vi.fn(async () => {}) },
    ready: { use: opts.ready ?? true },
    rpc: vi.fn(async (method: string) => {
      if (method === "getnodeinfo") return { time: 1_000_000, lastblock: { height: 777 } };
      return {};
    }),
  };
  // Real api.js: the list is on the pinged proxy (api.get.current().api), Api has no `api`.
  const proxyApi = { peertubeserversList: vi.fn(async (): Promise<string[]> => ["old.peertube.example"]) };
  Object.assign(api, { get: { current: vi.fn(() => ({ api: proxyApi })) } });
  const actions = { prepare: vi.fn(), addAccount: vi.fn() };
  Object.assign(init as unknown as Record<string, unknown>, { api, actions, _available: true });
  return { init, api, actions, ping, proxyApi };
}

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe("AppInitializer boot RPCs", () => {
  beforeEach(() => {
    resetNodeFailover();
    setTimeDifference.mockClear();
    setArchived.mockClear();
    loadArchivedDirect.mockClear();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("node time and block height share one getnodeinfo, sent after the ping", async () => {
    const { init, api, ping } = withFakeApi();

    const time = init.syncNodeTime();
    const height = init.getBlockHeight();
    await flush();
    expect(api.rpc).not.toHaveBeenCalled();

    ping.resolve();
    await expect(height).resolves.toBe(777);
    await time;

    expect(api.rpc.mock.calls.filter(([m]) => m === "getnodeinfo")).toHaveLength(1);
    expect(setTimeDifference).toHaveBeenCalledTimes(1);
  });

  it("reuses a fresh getnodeinfo for a later block-height read", async () => {
    const { init, api, ping } = withFakeApi();
    ping.resolve();
    await init.syncNodeTime();

    await expect(init.getBlockHeight()).resolves.toBe(777);
    expect(api.rpc.mock.calls.filter(([m]) => m === "getnodeinfo")).toHaveLength(1);
  });

  it("pings once for every caller and retries the ping after a failed one", async () => {
    const { init, api, ping } = withFakeApi({ ready: false });
    ping.resolve();
    await expect(init.whenApiReady()).resolves.toBe(false);

    api.ready.use = true;
    await expect(init.whenApiReady()).resolves.toBe(true);
    await init.whenApiReady();
    expect(api.wait.ready).toHaveBeenCalledTimes(2);
  });

  it("loads the profile and node time only after the ping", async () => {
    const { init, api, actions, ping } = withFakeApi();
    const loadUserData = vi.spyOn(init, "loadUserData").mockResolvedValue(null);

    const pending = init.initializeAndFetchUserData("addr");
    await flush();
    expect(loadUserData).not.toHaveBeenCalled();
    expect(api.rpc).not.toHaveBeenCalled();

    ping.resolve();
    await pending;
    expect(loadUserData).toHaveBeenCalledWith(["addr"], undefined, undefined);
    expect(actions.addAccount).toHaveBeenCalledWith("addr");
    expect(api.rpc).toHaveBeenCalledWith("getnodeinfo");
  });

  it("asks the pinged proxy for archived peertube hosts, once", async () => {
    const { init, ping, proxyApi } = withFakeApi();
    const first = init.loadArchivedPeertubeServers();
    await flush();
    expect(proxyApi.peertubeserversList).not.toHaveBeenCalled();

    ping.resolve();
    await first;
    await init.loadArchivedPeertubeServers();

    expect(proxyApi.peertubeserversList).toHaveBeenCalledTimes(1);
    expect(setArchived).toHaveBeenCalledWith(["old.peertube.example"]);
    expect(loadArchivedDirect).not.toHaveBeenCalled();
  });

  it("falls back to the first proxy for peertube hosts without the Bastyon Api", async () => {
    const init = createAppInitializer();
    await init.loadArchivedPeertubeServers();
    expect(loadArchivedDirect).toHaveBeenCalledTimes(1);
  });

  it("skips the request while the stored list is fresh", async () => {
    const { init, ping, proxyApi } = withFakeApi();
    hasFresh.mockReturnValueOnce(true);
    ping.resolve();
    await init.loadArchivedPeertubeServers();
    expect(proxyApi.peertubeserversList).not.toHaveBeenCalled();
    expect(loadArchivedDirect).not.toHaveBeenCalled();
  });

  it("asks the proxy directly when the ping picked no proxy", async () => {
    const { init, api, ping } = withFakeApi();
    (api as unknown as { get: { current: () => undefined } }).get.current = () => undefined;
    ping.resolve();
    await init.loadArchivedPeertubeServers();
    expect(loadArchivedDirect).toHaveBeenCalledTimes(1);
  });

  it("asks the proxy directly when the ping never settles", async () => {
    vi.useFakeTimers();
    try {
      const { init, proxyApi } = withFakeApi();
      loadArchivedDirect.mockResolvedValueOnce(["old.peertube.example"]);
      const pending = init.loadArchivedPeertubeServers();
      await vi.advanceTimersByTimeAsync(10_000);
      await pending;
      expect(proxyApi.peertubeserversList).not.toHaveBeenCalled();
      expect(loadArchivedDirect).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("asks the proxy directly when the SDK call hangs, and retries when that finds nothing", async () => {
    vi.useFakeTimers();
    try {
      const { init, ping, proxyApi } = withFakeApi();
      proxyApi.peertubeserversList.mockImplementation(() => new Promise<string[]>(() => {}));
      ping.resolve();
      const pending = init.loadArchivedPeertubeServers();
      await vi.advanceTimersByTimeAsync(10_000);
      await pending;
      expect(loadArchivedDirect).toHaveBeenCalledTimes(1);
      expect(setArchived).not.toHaveBeenCalled();

      // Empty result is not cached: the next call asks again.
      const again = init.loadArchivedPeertubeServers();
      await vi.advanceTimersByTimeAsync(10_000);
      await again;
      expect(loadArchivedDirect).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("getSubscribesChannels waits for the ping", async () => {
    const { init, ping } = withFakeApi();
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: { channels: [], height: 1 } }),
    }));
    vi.stubGlobal("fetch", fetchSpy);

    const pending = init.getSubscribesChannels("addr");
    await flush();
    expect(fetchSpy).not.toHaveBeenCalled();

    ping.resolve();
    await expect(pending).resolves.toEqual({ channels: [], height: 1 });
    expect(fetchSpy).toHaveBeenCalled();
  });
});
