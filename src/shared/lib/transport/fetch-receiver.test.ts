// @vitest-environment node
/**
 * public/js/transports2/fetch/receiver.js ships as-is (the Electron service
 * worker importScripts it), so it runs here in a vm context. The main process
 * on the other end of the BroadcastChannel is played by the test.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createContext, runInContext } from "node:vm";
import { describe, expect, it } from "vitest";

const SOURCE = readFileSync(
  resolve(process.cwd(), "public/js/transports2/fetch/receiver.js"),
  "utf8",
);

interface Message {
  name: string;
  id: string;
  data?: unknown;
}

/** In-memory channel: messages from the receiver are recorded, the test replies through `reply`. */
class FakeChannel {
  static sent: Message[] = [];
  static current: FakeChannel | null = null;
  onmessage: ((e: { data: Message }) => void) | null = null;

  constructor() {
    FakeChannel.current = this;
  }

  postMessage(message: Message) {
    FakeChannel.sent.push(message);
  }

  static reply(message: Message) {
    FakeChannel.current?.onmessage?.({ data: message });
  }
}

type ReceiverFetch = (input: RequestInfo, init?: RequestInit) => Promise<Response>;

function loadReceiver(): ReceiverFetch {
  FakeChannel.sent = [];
  const self: { FetchReceiver?: { init(name: string): ReceiverFetch } } = {};
  const context = createContext({
    self,
    BroadcastChannel: FakeChannel,
    Request,
    Response,
    Headers,
    ReadableStream,
    AbortController,
    DOMException,
  });
  runInContext(SOURCE, context);
  return self.FetchReceiver!.init("ExtendedFetch");
}

const tick = () => new Promise((r) => setTimeout(r, 0));

function sentNames() {
  return FakeChannel.sent.map((m) => m.name);
}

describe("Electron SW fetch receiver", () => {
  it("relays a request and builds the response from the main process's reply", async () => {
    const fetch = loadReceiver();

    const pending = fetch(new Request("https://api.bastyon.com/x"));
    await tick();
    const { id } = FakeChannel.sent[0];
    FakeChannel.reply({ name: "InitialData", id, data: { status: 200, headers: {} } });
    FakeChannel.reply({ name: "Data", id, data: [104, 105] });
    FakeChannel.reply({ name: "End", id });

    const response = await pending;
    expect(sentNames()).toEqual(["Request"]);
    expect(await response.text()).toBe("hi");
  });

  it("sends Abort and rejects when the page aborts before the response", async () => {
    const fetch = loadReceiver();
    const controller = new AbortController();

    const pending = fetch(new Request("https://api.bastyon.com/x", { signal: controller.signal }));
    await tick();
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    const [request, abort] = FakeChannel.sent;
    expect(abort).toEqual({ name: "Abort", id: request.id });
  });

  it("does not send a request the page already aborted", async () => {
    const fetch = loadReceiver();
    const controller = new AbortController();
    controller.abort();

    await expect(
      fetch(new Request("https://api.bastyon.com/x", { signal: controller.signal })),
    ).rejects.toMatchObject({ name: "AbortError" });
    await tick();

    expect(sentNames()).not.toContain("Request");
  });

  it("sends Abort when the page stops reading the body", async () => {
    const fetch = loadReceiver();

    const pending = fetch(new Request("https://api.bastyon.com/big.mp4"));
    await tick();
    const { id } = FakeChannel.sent[0];
    FakeChannel.reply({ name: "InitialData", id, data: { status: 200, headers: {} } });
    const response = await pending;
    await response.body!.cancel();

    expect(FakeChannel.sent.at(-1)).toEqual({ name: "Abort", id });
  });

  it("fails the body, not just the promise, when an abort cuts it off", async () => {
    const fetch = loadReceiver();
    const controller = new AbortController();

    const pending = fetch(new Request("https://api.bastyon.com/x", { signal: controller.signal }));
    await tick();
    const { id } = FakeChannel.sent[0];
    FakeChannel.reply({ name: "InitialData", id, data: { status: 200, headers: {} } });
    FakeChannel.reply({ name: "Data", id, data: [1, 2] });
    const response = await pending;
    controller.abort();

    await expect(response.arrayBuffer()).rejects.toMatchObject({ name: "AbortError" });
  });

  it("fails the body when the main process reports an error mid-stream", async () => {
    const fetch = loadReceiver();

    const pending = fetch(new Request("https://api.bastyon.com/x"));
    await tick();
    const { id } = FakeChannel.sent[0];
    FakeChannel.reply({ name: "InitialData", id, data: { status: 200, headers: {} } });
    const response = await pending;
    FakeChannel.reply({ name: "Error", id });

    await expect(response.text()).rejects.toThrow("Failed to fetch");
  });

  it("rejects when the main process reports an error", async () => {
    const fetch = loadReceiver();

    const pending = fetch(new Request("https://api.bastyon.com/x"));
    await tick();
    FakeChannel.reply({ name: "Error", id: FakeChannel.sent[0].id });

    await expect(pending).rejects.toBeUndefined();
  });
});
