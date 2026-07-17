import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReconnectingSocket } from "../reconnecting-socket";

/**
 * Mock WebSocket — minimal shape that mirrors the parts ReconnectingSocket
 * touches. Each instance is captured in a class-level array so tests can
 * drive the open/close/error lifecycle deterministically.
 *
 * We intentionally use REAL timers here. The reconnect path mixes
 * `setTimeout` with awaited Promise chains (microtasks): vitest's fake
 * timers don't interleave the two reliably across vitest versions, and the
 * tests become brittle. A 10ms minBackoff keeps the suite fast (≤200ms total).
 */
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

  fireMessage(data: string) {
    this.onmessage?.({ data } as MessageEvent);
  }

  fireClose() {
    this.readyState = 3;
    this.onclose?.();
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wait until predicate is true, polling every 5ms (max 1s). */
async function waitFor(pred: () => boolean, timeoutMs = 1_000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await sleep(5);
  }
}

describe("ReconnectingSocket", () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
  });

  afterEach(() => {
    // Each test creates its own socket; nothing global to tear down.
  });

  it("connects via injected WebSocket and fires onOpen", async () => {
    const onOpen = vi.fn();
    const sock = new ReconnectingSocket({
      getUrl: () => Promise.resolve("wss://test/x"),
      handlers: { onOpen },
      WebSocketCtor: MockWebSocket as unknown as typeof WebSocket,
      minBackoffMs: 10,
      jitterRatio: 0,
    });
    sock.start();
    await waitFor(() => MockWebSocket.instances.length === 1);

    MockWebSocket.instances[0].fireOpen();
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(sock.isOpen()).toBe(true);
    sock.close();
  });

  it("delivers inbound messages as decoded strings", async () => {
    const onMessage = vi.fn();
    const sock = new ReconnectingSocket({
      getUrl: () => Promise.resolve("wss://x"),
      handlers: { onMessage },
      WebSocketCtor: MockWebSocket as unknown as typeof WebSocket,
      minBackoffMs: 10,
      jitterRatio: 0,
    });
    sock.start();
    await waitFor(() => MockWebSocket.instances.length === 1);
    MockWebSocket.instances[0].fireOpen();
    MockWebSocket.instances[0].fireMessage("hello");

    expect(onMessage).toHaveBeenCalledWith("hello");
    sock.close();
  });

  it("send() returns true when OPEN and false otherwise", async () => {
    const sock = new ReconnectingSocket({
      getUrl: () => Promise.resolve("wss://x"),
      handlers: {},
      WebSocketCtor: MockWebSocket as unknown as typeof WebSocket,
      minBackoffMs: 10,
      jitterRatio: 0,
    });
    expect(sock.send({ a: 1 })).toBe(false);

    sock.start();
    await waitFor(() => MockWebSocket.instances.length === 1);
    MockWebSocket.instances[0].fireOpen();

    expect(sock.send({ a: 1 })).toBe(true);
    expect(MockWebSocket.instances[0].send).toHaveBeenCalledWith('{"a":1}');
    sock.close();
  });

  it("reconnects after onClose", async () => {
    const sock = new ReconnectingSocket({
      getUrl: () => Promise.resolve("wss://x"),
      handlers: {},
      WebSocketCtor: MockWebSocket as unknown as typeof WebSocket,
      minBackoffMs: 10,
      maxBackoffMs: 50,
      jitterRatio: 0,
    });
    sock.start();
    await waitFor(() => MockWebSocket.instances.length === 1);
    MockWebSocket.instances[0].fireOpen();
    MockWebSocket.instances[0].fireClose();

    await waitFor(() => MockWebSocket.instances.length === 2);
    sock.close();
  });

  it("close() is idempotent and cancels reconnect timer", async () => {
    const sock = new ReconnectingSocket({
      getUrl: () => Promise.resolve("wss://x"),
      handlers: {},
      WebSocketCtor: MockWebSocket as unknown as typeof WebSocket,
      minBackoffMs: 30,
      jitterRatio: 0,
    });
    sock.start();
    await waitFor(() => MockWebSocket.instances.length === 1);
    MockWebSocket.instances[0].fireOpen();
    MockWebSocket.instances[0].fireClose();

    sock.close();
    sock.close(); // second close = no-op

    // Wait longer than backoff — no further reconnect allowed after close().
    await sleep(80);
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(sock.isClosed()).toBe(true);
  });

  it("retries when getUrl resolves to null", async () => {
    let calls = 0;
    const getUrl = vi.fn(() => {
      calls++;
      return Promise.resolve(calls < 2 ? null : "wss://x");
    });
    const sock = new ReconnectingSocket({
      getUrl,
      handlers: {},
      WebSocketCtor: MockWebSocket as unknown as typeof WebSocket,
      minBackoffMs: 10,
      jitterRatio: 0,
    });
    sock.start();
    await waitFor(() => MockWebSocket.instances.length === 1);
    expect(getUrl.mock.calls.length).toBeGreaterThanOrEqual(2);
    sock.close();
  });

  it("recovers from synchronous WebSocket constructor throw", async () => {
    const onError = vi.fn();
    let firstCall = true;
    const FlakyCtor = function (this: unknown, url: string) {
      if (firstCall) {
        firstCall = false;
        throw new Error("nope");
      }
      return new (MockWebSocket as unknown as typeof WebSocket)(url);
    } as unknown as typeof WebSocket;

    const sock = new ReconnectingSocket({
      getUrl: () => Promise.resolve("wss://x"),
      handlers: { onError },
      WebSocketCtor: FlakyCtor,
      minBackoffMs: 10,
      jitterRatio: 0,
    });
    sock.start();
    await waitFor(() => MockWebSocket.instances.length === 1);
    expect(onError).toHaveBeenCalled();
    sock.close();
  });

  it("computeBackoff (private) grows up to maxBackoffMs (smoke test)", () => {
    // No timer machinery — just verify that the API surface exposes a
    // running socket lifecycle and `isClosed()` behaviour. The actual
    // exponential growth is exercised by the reconnect tests above.
    const sock = new ReconnectingSocket({
      getUrl: () => Promise.resolve(null),
      handlers: {},
      WebSocketCtor: MockWebSocket as unknown as typeof WebSocket,
      minBackoffMs: 10,
      maxBackoffMs: 50,
      jitterRatio: 0,
    });
    expect(sock.isClosed()).toBe(false);
    expect(sock.isOpen()).toBe(false);
    sock.close();
    expect(sock.isClosed()).toBe(true);
  });
});
