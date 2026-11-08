import { describe, it, expect, vi } from "vitest";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";

const require = createRequire(import.meta.url);
const FetchMainHandler = require("./fetch-handler.cjs");

function makeSender() {
  return { send: vi.fn(), isDestroyed: vi.fn(() => false) };
}

function makeResponse(status = 200) {
  const body = new EventEmitter();
  const headers = new Headers({ "content-type": "application/json" });
  return { status, headers, body };
}

function setup(fetchFunction: ReturnType<typeof vi.fn>) {
  const ipcMain = new EventEmitter();
  const handler = FetchMainHandler.init(ipcMain, { fetchFunction });
  const sender = makeSender();
  const request = (id: string, data: Record<string, unknown>) =>
    ipcMain.emit("FetchBridge:Request", { sender }, id, data);
  return { ipcMain, handler, sender, request };
}

describe("electron tor FetchMainHandler", () => {
  it("passes the URL and the rest of the init to the fetch function", async () => {
    const fetchFunction = vi.fn().mockResolvedValue(makeResponse());
    const { request } = setup(fetchFunction);

    request("r1", { url: "https://api.bastyon.com/x", method: "POST", headers: { a: "1" } });

    const [url, init] = fetchFunction.mock.calls[0];
    expect(url).toBe("https://api.bastyon.com/x");
    expect(init).toMatchObject({ method: "POST", headers: { a: "1" } });
    expect(init).not.toHaveProperty("url");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("streams status, headers, body chunks and the end back to the sender", async () => {
    const response = makeResponse(201);
    const { request, sender, handler } = setup(vi.fn().mockResolvedValue(response));

    request("r1", { url: "https://api.bastyon.com/x" });
    await vi.waitFor(() => expect(sender.send).toHaveBeenCalled());
    response.body.emit("data", Buffer.from([1, 2, 3]));
    response.body.emit("end");

    expect(sender.send.mock.calls).toEqual([
      ["FetchBridge:r1:InitialData", {
        url: "https://api.bastyon.com/x",
        status: 201,
        headers: { "content-type": "application/json" },
      }],
      ["FetchBridge:r1:Data", [1, 2, 3]],
      ["FetchBridge:r1:End", undefined],
    ]);
    expect(handler.requests).not.toHaveProperty("r1");
  });

  it("reports a failed fetch as an error and forgets the request", async () => {
    const { request, sender, handler } = setup(vi.fn().mockRejectedValue(new Error("down")));

    request("r1", { url: "https://api.bastyon.com/x" });

    await vi.waitFor(() =>
      expect(sender.send).toHaveBeenCalledWith("FetchBridge:r1:Error", undefined));
    expect(handler.requests).not.toHaveProperty("r1");
  });

  it("aborts the fetch when the renderer sends Abort, without replying", async () => {
    // Rejects like node-fetch does once its signal aborts.
    const fetchFunction = vi.fn((_url: string, init: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () =>
          reject(Object.assign(new Error("The user aborted a request."), { type: "aborted" })));
      }));
    const { ipcMain, request, sender, handler } = setup(fetchFunction);

    request("r1", { url: "https://api.bastyon.com/x" });
    ipcMain.emit("FetchBridge:r1:Abort");
    await new Promise((r) => setTimeout(r, 0));

    expect(fetchFunction.mock.calls[0][1].signal.aborted).toBe(true);
    expect(sender.send).not.toHaveBeenCalled();
    expect(handler.requests).not.toHaveProperty("r1");
    expect(ipcMain.listenerCount("FetchBridge:r1:Abort")).toBe(0);
  });

  it("reports a connection dropped mid-body as an error instead of crashing", async () => {
    const response = makeResponse();
    const { request, sender, handler } = setup(vi.fn().mockResolvedValue(response));

    request("r1", { url: "https://api.bastyon.com/x" });
    await vi.waitFor(() => expect(sender.send).toHaveBeenCalled());
    // Throws if nothing listens for 'error' on the body stream.
    response.body.emit("error", new Error("Premature close"));

    expect(sender.send).toHaveBeenLastCalledWith("FetchBridge:r1:Error", undefined);
    expect(handler.requests).not.toHaveProperty("r1");
  });

  it("stays silent when an abort ends the body stream", async () => {
    const response = makeResponse();
    const { ipcMain, request, sender } = setup(vi.fn().mockResolvedValue(response));

    request("r1", { url: "https://api.bastyon.com/x" });
    await vi.waitFor(() => expect(sender.send).toHaveBeenCalledTimes(1));
    ipcMain.emit("FetchBridge:r1:Abort");
    response.body.emit("error", Object.assign(new Error("aborted"), { type: "aborted" }));

    expect(sender.send).toHaveBeenCalledTimes(1);
  });

  it("drops the abort listener once the response ends", async () => {
    const response = makeResponse();
    const { ipcMain, request, sender } = setup(vi.fn().mockResolvedValue(response));

    request("r1", { url: "https://api.bastyon.com/x" });
    await vi.waitFor(() => expect(sender.send).toHaveBeenCalled());
    response.body.emit("end");

    expect(ipcMain.listenerCount("FetchBridge:r1:Abort")).toBe(0);
  });

  it("does not send to a destroyed window", async () => {
    const { request, sender } = setup(vi.fn().mockResolvedValue(makeResponse()));
    sender.isDestroyed.mockReturnValue(true);

    request("r1", { url: "https://api.bastyon.com/x" });
    await new Promise((r) => setTimeout(r, 0));

    expect(sender.send).not.toHaveBeenCalled();
  });

  it("keeps concurrent requests apart by id", async () => {
    const first = makeResponse();
    const second = makeResponse(404);
    const fetchFunction = vi.fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    const { request, sender } = setup(fetchFunction);

    request("a", { url: "https://one.example/" });
    request("b", { url: "https://two.example/" });
    await vi.waitFor(() => expect(sender.send).toHaveBeenCalledTimes(2));
    second.body.emit("end");

    const events = sender.send.mock.calls.map(([name]) => name);
    expect(events).toEqual([
      "FetchBridge:a:InitialData",
      "FetchBridge:b:InitialData",
      "FetchBridge:b:End",
    ]);
  });
});
