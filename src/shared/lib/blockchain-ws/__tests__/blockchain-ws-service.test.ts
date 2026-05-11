import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBlockchainWsServiceForTesting } from "../blockchain-ws-service";
import { resetGetMissedThrottle } from "../getmissed";
import type { BlockchainWsRpcAdapter, SignaturePayload } from "../types";

class MockWebSocket {
  static instances: MockWebSocket[] = [];

  url: string;
  readyState = 0;
  onopen: ((ev: Event) => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;

  send = vi.fn();
  close = vi.fn(() => {
    this.readyState = 3;
    this.onclose?.();
  });

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  fireOpen() {
    this.readyState = 1;
    this.onopen?.(new Event("open"));
  }

  fireMessage(payload: unknown) {
    const data = typeof payload === "string" ? payload : JSON.stringify(payload);
    this.onmessage?.({ data } as MessageEvent);
  }
}

const validSig: SignaturePayload = {
  nonce: "n",
  signature: "s",
  pubkey: "p",
  address: "PADDR",
  v: 1,
};

function makeApi(overrides?: { currentwss?: () => Promise<unknown>; rpc?: (m: string, p?: unknown[]) => Promise<unknown> }): BlockchainWsRpcAdapter {
  const currentwss = overrides?.currentwss ?? (() => Promise.resolve({ url: "wss://test/x", proxy: {} }));
  const rpc = overrides?.rpc ?? (() => Promise.resolve([]));
  return {
    rpc: vi.fn(rpc) as unknown as BlockchainWsRpcAdapter["rpc"],
    get: {
      currentwss: vi.fn(currentwss) as unknown as BlockchainWsRpcAdapter["get"]["currentwss"],
    },
  };
}

function makeService() {
  return createBlockchainWsServiceForTesting({
    WebSocketCtor: MockWebSocket as unknown as typeof WebSocket,
    attachFocusListener: false,
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wait until a predicate becomes true (polled every 5ms, max 1s). */
async function waitFor(pred: () => boolean, timeoutMs = 1_000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await sleep(5);
  }
}

describe("BlockchainWsService", () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
    resetGetMissedThrottle();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("aborts start() when SDK Api is not ready (no exceptions)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const svc = makeService();
    svc.start({
      address: "PADDR",
      deviceId: "device-1",
      getSignature: () => validSig,
      getApi: () => null,
      getLastKnownBlock: () => 100,
      handlers: {},
    });
    expect(MockWebSocket.instances).toHaveLength(0);
    expect(warn).toHaveBeenCalled();
    svc.destroy();
  });

  it("aborts start() when signature is missing", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const svc = makeService();
    svc.start({
      address: "PADDR",
      deviceId: "device-1",
      getSignature: () => null,
      getApi: () => makeApi(),
      getLastKnownBlock: () => 100,
      handlers: {},
    });
    expect(MockWebSocket.instances).toHaveLength(0);
    expect(warn).toHaveBeenCalled();
    svc.destroy();
  });

  it("falls back silently when currentwss() rejects", async () => {
    const svc = makeService();
    const api = makeApi({
      currentwss: () => Promise.reject(new Error("dead proxy")),
    });
    svc.start({
      address: "PADDR",
      deviceId: "device-1",
      getSignature: () => validSig,
      getApi: () => api,
      getLastKnownBlock: () => 100,
      handlers: {},
    });
    // Let the first connect attempt run + reject. Stop before the
    // exponential reconnect timer fires, otherwise the test loops forever.
    await sleep(50);
    expect(MockWebSocket.instances).toHaveLength(0);
    svc.destroy();
  });

  it("skips when proxy is in dummy/direct mode", async () => {
    const svc = makeService();
    const api = makeApi({
      currentwss: () => Promise.resolve({ dummy: {}, proxy: {} }),
    });
    svc.start({
      address: "PADDR",
      deviceId: "device-1",
      getSignature: () => validSig,
      getApi: () => api,
      getLastKnownBlock: () => 100,
      handlers: {},
    });
    await sleep(50);
    expect(MockWebSocket.instances).toHaveLength(0);
    svc.destroy();
  });

  it("sends a registration message with the right shape on open", async () => {
    const svc = makeService();
    const api = makeApi();
    svc.start({
      address: "PADDR",
      deviceId: "device-XYZ",
      getSignature: () => validSig,
      getApi: () => api,
      getLastKnownBlock: () => 999,
      handlers: {},
    });
    await waitFor(() => MockWebSocket.instances.length === 1);
    MockWebSocket.instances[0].fireOpen();

    expect(MockWebSocket.instances[0].send).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(MockWebSocket.instances[0].send.mock.calls[0][0]);
    expect(payload).toMatchObject({
      address: "PADDR",
      device: "device-XYZ",
      block: 999,
      node: null,
      signature: validSig,
    });
    svc.destroy();
  });

  it("dispatches new block events to onBlock", () => {
    const onBlock = vi.fn();
    const svc = makeService();
    svc.start({
      address: "PADDR",
      deviceId: "device-1",
      getSignature: () => validSig,
      getApi: () => makeApi(),
      getLastKnownBlock: () => 0,
      handlers: { onBlock },
    });
    svc.dispatch({ msg: "new block", height: 1234, time: 999 });
    expect(onBlock).toHaveBeenCalledWith({ height: 1234, time: 999 });
    svc.destroy();
  });

  it("dispatches transaction events to onTransaction", () => {
    const onTransaction = vi.fn();
    const svc = makeService();
    svc.start({
      address: "PADDR",
      deviceId: "device-1",
      getSignature: () => validSig,
      getApi: () => makeApi(),
      getLastKnownBlock: () => 0,
      handlers: { onTransaction },
    });
    svc.dispatch({ msg: "transaction", txid: "tx-1", addr: "PADDR", amount: 0.5 });
    expect(onTransaction).toHaveBeenCalledWith({
      txid: "tx-1",
      addr: "PADDR",
      time: undefined,
      amount: 0.5,
      nout: undefined,
      height: undefined,
      node: undefined,
    });
    svc.destroy();
  });

  it("dispatches event/userInfo only when addrFrom is set", () => {
    const onUserInfo = vi.fn();
    const svc = makeService();
    svc.start({
      address: "PADDR",
      deviceId: "device-1",
      getSignature: () => validSig,
      getApi: () => makeApi(),
      getLastKnownBlock: () => 0,
      handlers: { onUserInfo },
    });
    svc.dispatch({ msg: "event", mesType: "userInfo", addrFrom: "OTHER", txid: "t1" });
    svc.dispatch({ msg: "event", mesType: "userInfo" }); // no addrFrom — ignored
    expect(onUserInfo).toHaveBeenCalledTimes(1);
    expect(onUserInfo).toHaveBeenCalledWith({
      mesType: "userInfo",
      addrFrom: "OTHER",
      txid: "t1",
      time: undefined,
    });
    svc.destroy();
  });

  it("dedupes repeated txids across live + replay", () => {
    const onTransaction = vi.fn();
    const svc = makeService();
    svc.start({
      address: "PADDR",
      deviceId: "device-1",
      getSignature: () => validSig,
      getApi: () => makeApi(),
      getLastKnownBlock: () => 0,
      handlers: { onTransaction },
    });
    svc.dispatch({ msg: "transaction", txid: "DUPE", addr: "PADDR" });
    svc.dispatch({ msg: "transaction", txid: "DUPE", addr: "PADDR" });
    svc.dispatch({ msg: "transaction", txid: "OTHER", addr: "PADDR" });
    expect(onTransaction).toHaveBeenCalledTimes(2);
    svc.destroy();
  });

  it("ignores proxy-internal control messages", async () => {
    const onBlock = vi.fn();
    const svc = makeService();
    svc.start({
      address: "PADDR",
      deviceId: "device-1",
      getSignature: () => validSig,
      getApi: () => makeApi(),
      getLastKnownBlock: () => 0,
      handlers: { onBlock },
    });
    await waitFor(() => MockWebSocket.instances.length === 1);
    const ws = MockWebSocket.instances[0];
    ws.fireOpen();
    ws.fireMessage({ type: "proxy-message-tick", data: 1 });
    ws.fireMessage({ type: "changenode" });
    ws.fireMessage({ type: "proxy-settings-changed" });
    expect(onBlock).not.toHaveBeenCalled();
    svc.destroy();
  });

  it("stop() closes the socket and cancels reconnect", async () => {
    const svc = makeService();
    svc.start({
      address: "PADDR",
      deviceId: "device-1",
      getSignature: () => validSig,
      getApi: () => makeApi(),
      getLastKnownBlock: () => 100,
      handlers: {},
    });
    await waitFor(() => MockWebSocket.instances.length === 1);
    svc.stop();
    expect(MockWebSocket.instances[0].close).toHaveBeenCalled();
    expect(svc.isConnected()).toBe(false);
  });

  it("re-uses single connection on duplicate start with same address", async () => {
    const svc = makeService();
    const opts = {
      address: "PADDR",
      deviceId: "device-1",
      getSignature: () => validSig,
      getApi: () => makeApi(),
      getLastKnownBlock: () => 100,
      handlers: {},
    };
    svc.start(opts);
    await waitFor(() => MockWebSocket.instances.length === 1);
    svc.start(opts); // no-op
    await sleep(20);
    expect(MockWebSocket.instances).toHaveLength(1);
    svc.destroy();
  });

  it("triggers getmissedinfo replay through the same dispatcher on open", async () => {
    const onBlock = vi.fn();
    const onTransaction = vi.fn();
    const rpc = vi.fn().mockResolvedValue([
      { block: 200 },
      { msg: "transaction", txid: "missed-1", addr: "PADDR", nblock: 199 },
    ]);
    const api: BlockchainWsRpcAdapter = {
      rpc: rpc as unknown as BlockchainWsRpcAdapter["rpc"],
      get: {
        currentwss: vi.fn().mockResolvedValue({ url: "wss://x", proxy: {} }) as unknown as BlockchainWsRpcAdapter["get"]["currentwss"],
      },
    };
    const svc = makeService();
    svc.start({
      address: "PADDR",
      deviceId: "device-1",
      getSignature: () => validSig,
      getApi: () => api,
      getLastKnownBlock: () => 100,
      handlers: { onBlock, onTransaction },
    });
    await waitFor(() => MockWebSocket.instances.length === 1);
    MockWebSocket.instances[0].fireOpen();
    await waitFor(() => onTransaction.mock.calls.length > 0);

    expect(rpc).toHaveBeenCalledWith("getmissedinfo", ["PADDR", 100, 30]);
    expect(onBlock).toHaveBeenCalledWith({ height: 200, time: undefined });
    expect(onTransaction).toHaveBeenCalledTimes(1);
    expect(onTransaction.mock.calls[0][0].txid).toBe("missed-1");
    svc.destroy();
  });

  it("ignores invalid JSON over the wire without throwing", async () => {
    const onBlock = vi.fn();
    const svc = makeService();
    svc.start({
      address: "PADDR",
      deviceId: "device-1",
      getSignature: () => validSig,
      getApi: () => makeApi(),
      getLastKnownBlock: () => 100,
      handlers: { onBlock },
    });
    await waitFor(() => MockWebSocket.instances.length === 1);
    MockWebSocket.instances[0].fireOpen();
    expect(() => MockWebSocket.instances[0].fireMessage("{not-json")).not.toThrow();
    expect(onBlock).not.toHaveBeenCalled();
    svc.destroy();
  });
});
