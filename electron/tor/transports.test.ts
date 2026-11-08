import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRequire } from "node:module";

// transports.cjs is loaded through Node's require, which vi.mock does not
// reach; node-fetch is swapped in require.cache before each fresh load.
const require = createRequire(import.meta.url);
const TRANSPORTS_PATH = require.resolve("./transports.cjs");
const NODE_FETCH_PATH = createRequire(TRANSPORTS_PATH).resolve("node-fetch");

type Mode = "neveruse" | "auto" | "always";
type FetchStub = ReturnType<typeof vi.fn>;

function loadTransports(nodeFetch: FetchStub) {
  const realFetch = require.cache[NODE_FETCH_PATH];
  require.cache[NODE_FETCH_PATH] = { exports: nodeFetch } as NodeJS.Module;
  delete require.cache[TRANSPORTS_PATH];
  try {
    return require(TRANSPORTS_PATH);
  } finally {
    if (realFetch) require.cache[NODE_FETCH_PATH] = realFetch;
    else delete require.cache[NODE_FETCH_PATH];
  }
}

function makeTorControl(mode: Mode, started = false) {
  const listeners: Array<(status: string) => void> = [];
  const ctrl = {
    settings: { enabled3: mode },
    started,
    isStarted: () => ctrl.started,
    start: vi.fn(),
    resetTimer: vi.fn(),
    onAny: (listener: (status: string) => void) => listeners.push(listener),
    emit: (status: string) => {
      ctrl.started = status === "started";
      listeners.forEach((l) => l(status));
    },
  };
  return ctrl;
}

function okResponse() {
  return { status: 200, headers: new Headers() };
}

function netError(code: string, message = code) {
  return Object.assign(new Error(message), { code });
}

function setup(mode: Mode, opts: { started?: boolean; direct?: boolean } = {}) {
  const nodeFetch = vi.fn().mockImplementation(async () => okResponse());
  const Transports = loadTransports(nodeFetch);
  const torControl = makeTorControl(mode, opts.started ?? false);
  const transports = new Transports(torControl);
  const pingHost = vi.fn().mockResolvedValue(opts.direct ?? true);
  transports.pingHost = pingHost;
  return { nodeFetch, torControl, transports, pingHost };
}

describe("electron tor transports — isTorNeeded", () => {
  it("neveruse: never routes through Tor and never pings or starts Tor", async () => {
    const { transports, torControl, pingHost } = setup("neveruse");

    expect(await transports.isTorNeeded("https://api.bastyon.com/x")).toBe(false);
    expect(pingHost).not.toHaveBeenCalled();
    expect(torControl.start).not.toHaveBeenCalled();
  });

  it("always: routes through a running Tor without probing direct access", async () => {
    const { transports, pingHost } = setup("always", { started: true });

    expect(await transports.isTorNeeded("https://api.bastyon.com/x")).toBe(true);
    expect(pingHost).not.toHaveBeenCalled();
  });

  it("always: starts Tor and waits for it when it is not running", async () => {
    const { transports, torControl } = setup("always");

    const pending = transports.isTorNeeded("https://api.bastyon.com/x");
    await vi.waitFor(() => expect(torControl.start).toHaveBeenCalled());
    torControl.emit("started");

    expect(await pending).toBe(true);
  });

  it("always: answers false when Tor fails to start", async () => {
    const { transports, torControl } = setup("always");

    const pending = transports.isTorNeeded("https://api.bastyon.com/x");
    await vi.waitFor(() => expect(torControl.start).toHaveBeenCalled());
    torControl.emit("failed");

    expect(await pending).toBe(false);
  });

  it("always: a failed start does not answer for the next one", async () => {
    const { transports, torControl } = setup("always");

    const first = transports.isTorNeeded("https://api.bastyon.com/x");
    await vi.waitFor(() => expect(torControl.start).toHaveBeenCalledTimes(1));
    torControl.emit("failed");
    expect(await first).toBe(false);

    const second = transports.isTorNeeded("https://api.bastyon.com/x");
    await vi.waitFor(() => expect(torControl.start).toHaveBeenCalledTimes(2));
    torControl.emit("started");
    expect(await second).toBe(true);
  });

  it("subscribes to Tor state once, however many requests wait", async () => {
    const { transports, torControl } = setup("always");
    const onAny = vi.spyOn(torControl, "onAny");

    const waits = [transports.waitTorReady(), transports.waitTorReady()];
    torControl.emit("started");

    expect(await Promise.all(waits)).toEqual([true, true]);
    expect(onAny).not.toHaveBeenCalled();
  });

  it("always: the 'stopped' of an install or restart does not end the wait", async () => {
    const { transports, torControl } = setup("always");

    const pending = transports.waitTorReady();
    torControl.emit("stopped");
    torControl.emit("running");
    torControl.emit("started");

    expect(await pending).toBe(true);
  });

  it("answers false when Tor is switched off during the wait", async () => {
    const { transports, torControl } = setup("always");

    const pending = transports.waitTorReady();
    torControl.settings.enabled3 = "neveruse";
    torControl.emit("stopped");

    expect(await pending).toBe(false);
  });

  it("gives up after 60 s with one timer for all waiting requests", async () => {
    vi.useFakeTimers();
    try {
      const { transports } = setup("always");

      const waits = [transports.waitTorReady(), transports.waitTorReady()];
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(60_000);

      expect(await Promise.all(waits)).toEqual([false, false]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears the timeout once Tor starts", async () => {
    vi.useFakeTimers();
    try {
      const { transports, torControl } = setup("always");

      const pending = transports.waitTorReady();
      torControl.emit("started");

      expect(await pending).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("auto: goes direct when the host answers", async () => {
    const { transports, torControl } = setup("auto", { started: true, direct: true });

    expect(await transports.isTorNeeded("https://api.bastyon.com/x")).toBe(false);
    expect(torControl.start).not.toHaveBeenCalled();
  });

  it("auto: routes through Tor when the host is unreachable directly", async () => {
    const { transports } = setup("auto", { started: true, direct: false });

    expect(await transports.isTorNeeded("https://api.bastyon.com/x")).toBe(true);
  });
});

describe("electron tor transports — hasDirectAccess", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("treats loopback addresses as direct without pinging", async () => {
    const { transports, pingHost } = setup("auto");

    expect(await transports.hasDirectAccess("http://127.0.0.1:8181/x")).toBe(true);
    expect(pingHost).not.toHaveBeenCalled();
  });

  it("pings the default port for the protocol", async () => {
    const { transports, pingHost } = setup("auto");

    await transports.hasDirectAccess("https://api.bastyon.com/x");
    await transports.hasDirectAccess("http://other.example/x");

    expect(pingHost).toHaveBeenCalledWith("api.bastyon.com", 443);
    expect(pingHost).toHaveBeenCalledWith("other.example", 80);
  });

  it("caches the result per host", async () => {
    const { transports, pingHost } = setup("auto", { direct: false });

    expect(await transports.hasDirectAccess("https://api.bastyon.com/a")).toBe(false);
    expect(await transports.hasDirectAccess("https://api.bastyon.com/b")).toBe(false);
    expect(pingHost).toHaveBeenCalledTimes(1);
  });

  it("shares one ping between concurrent requests to the same host", async () => {
    const { transports, pingHost } = setup("auto");

    const results = await Promise.all([
      transports.hasDirectAccess("https://api.bastyon.com/a"),
      transports.hasDirectAccess("https://api.bastyon.com/b"),
    ]);

    expect(results).toEqual([true, true]);
    expect(pingHost).toHaveBeenCalledTimes(1);
  });

  it("re-probes a failed host after 10 minutes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { transports, pingHost } = setup("auto", { direct: false });

    await transports.hasDirectAccess("https://api.bastyon.com/a");
    vi.setSystemTime(Date.now() + 10 * 60 * 1000);
    await transports.hasDirectAccess("https://api.bastyon.com/b");

    expect(pingHost).toHaveBeenCalledTimes(2);
  });
});

describe("electron tor transports — fetch", () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it("neveruse: fetches directly and tags the response as direct", async () => {
    const { transports, nodeFetch } = setup("neveruse");

    const res = await transports.fetch("https://api.bastyon.com/x", { method: "GET" });

    expect(nodeFetch.mock.calls[0][1].agent).toBeUndefined();
    expect(res.headers.get("#bastyon-proxy-transport")).toBe("direct");
  });

  it("always: attaches the SOCKS agent on 9250 and tags the response as tor", async () => {
    const { transports, nodeFetch, torControl } = setup("always");

    const pending = transports.fetch("https://api.bastyon.com/x", {});
    await Promise.resolve();
    torControl.emit("started");
    const res = await pending;

    const agent = nodeFetch.mock.calls[0][1].agent;
    expect(agent).toBe(transports.getTorAgent());
    expect(agent.proxy.port).toBe(9250);
    expect(res.headers.get("#bastyon-proxy-transport")).toBe("tor");
  });

  it("always: uses an already running Tor without waiting for a start event", async () => {
    const { transports, nodeFetch } = setup("always", { started: true });

    const res = await transports.fetch("https://api.bastyon.com/x", {});

    expect(nodeFetch.mock.calls[0][1].agent).toBe(transports.getTorAgent());
    expect(res.headers.get("#bastyon-proxy-transport")).toBe("tor");
  });

  it("always: waits for a restart once Tor stopped after a successful start", async () => {
    const { transports, torControl, nodeFetch } = setup("always", { started: true });
    torControl.emit("stopped");

    const pending = transports.fetch("https://api.bastyon.com/x", {});
    await Promise.resolve();
    expect(nodeFetch).not.toHaveBeenCalled();
    torControl.emit("started");

    expect((await pending).headers.get("#bastyon-proxy-transport")).toBe("tor");
  });

  it("always: refuses to fall back to a direct connection when Tor did not start", async () => {
    const { transports, nodeFetch, torControl } = setup("always");

    const pending = transports.fetch("https://api.bastyon.com/x", {});
    await Promise.resolve();
    torControl.emit("failed");

    await expect(pending).rejects.toThrow("Failed to fetch");
    expect(nodeFetch).not.toHaveBeenCalled();
  });

  it("auto: resets the idle timer when a request goes through Tor", async () => {
    const { transports, torControl } = setup("auto", { started: true, direct: false });

    await transports.fetch("https://api.bastyon.com/x", {});

    expect(torControl.resetTimer).toHaveBeenCalled();
  });

  it("auto: retries through Tor when a direct request fails with a network error", async () => {
    const { transports, nodeFetch } = setup("auto", { started: true });
    // Both attempts share one options object, so record the agent per call.
    const agents: unknown[] = [];
    nodeFetch.mockImplementation(async (_url: string, init: { agent?: unknown }) => {
      agents.push(init.agent);
      if (agents.length > 1) return okResponse();
      throw netError("ETIMEDOUT");
    });

    const res = await transports.fetch("https://api.bastyon.com/x", {});

    expect(agents).toEqual([undefined, transports.getTorAgent()]);
    expect(res.headers.get("#bastyon-proxy-transport")).toBe("tor");
  });

  it("auto: a failed direct request has the host probed again for the next ones", async () => {
    const { transports, nodeFetch, pingHost } = setup("auto", { started: true });
    nodeFetch.mockRejectedValueOnce(netError("ECONNRESET"));
    pingHost.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    await transports.fetch("https://api.bastyon.com/a", {});
    const res = await transports.fetch("https://api.bastyon.com/b", {});

    expect(pingHost).toHaveBeenCalledTimes(2);
    expect(res.headers.get("#bastyon-proxy-transport")).toBe("tor");
  });

  it("auto: a host that passes the new probe goes direct again", async () => {
    const { transports, nodeFetch } = setup("auto", { started: true });
    nodeFetch.mockRejectedValueOnce(netError("ECONNRESET"));

    await transports.fetch("https://api.bastyon.com/a", {});
    const res = await transports.fetch("https://api.bastyon.com/b", {});

    expect(res.headers.get("#bastyon-proxy-transport")).toBe("direct");
  });

  it("neveruse: retries a failed request directly and leaves the host unmarked", async () => {
    const { transports, nodeFetch } = setup("neveruse");
    nodeFetch.mockRejectedValueOnce(netError("ECONNRESET"));

    const res = await transports.fetch("https://api.bastyon.com/x", {});

    expect(nodeFetch).toHaveBeenCalledTimes(2);
    expect(res.headers.get("#bastyon-proxy-transport")).toBe("direct");
    expect(transports.accessRecords).toEqual({});
  });

  it("passes non-network errors through without a retry", async () => {
    const { transports, nodeFetch } = setup("auto", { started: true });
    const error = netError("ERR_INVALID_URL");
    nodeFetch.mockRejectedValueOnce(error);

    await expect(transports.fetch("https://api.bastyon.com/x", {})).rejects.toBe(error);
    expect(nodeFetch).toHaveBeenCalledTimes(1);
  });

  it("swallows a SOCKS rejection from Tor instead of throwing", async () => {
    const { transports, nodeFetch } = setup("auto", { started: true, direct: false });
    nodeFetch.mockRejectedValueOnce(new Error("Socks5 proxy rejected connection - Failure"));

    await expect(transports.fetch("https://api.bastyon.com/x", {})).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith("SOCKS5 proxy rejection");
  });
});

describe("electron tor transports — error classifiers", () => {
  it("checkForAgentError recognises SOCKS failures only", () => {
    const { transports } = setup("auto");

    expect(transports.checkForAgentError(new Error("Socks5 proxy rejected connection"))).toBe(true);
    expect(transports.checkForAgentError(new Error('A "socket" was not created'))).toBe(true);
    expect(transports.checkForAgentError(new Error("ECONNRESET"))).toBe(false);
  });

  it("isTorRefuseConnections matches a refused local SOCKS port", () => {
    const { transports } = setup("auto");

    expect(transports.isTorRefuseConnections(new Error("connect ECONNREFUSED 127.0.0.1:9250"))).toBe(true);
    expect(transports.isTorRefuseConnections(new Error("connect ECONNREFUSED 1.2.3.4:443"))).toBe(false);
  });
});
