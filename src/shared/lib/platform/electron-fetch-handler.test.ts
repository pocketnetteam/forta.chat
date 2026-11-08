import { describe, it, expect, vi } from "vitest";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";

const require = createRequire(import.meta.url);
const FetchMainHandler = require("../../../../electron/tor/fetch-handler.cjs") as {
  init: (ipcMain: EventEmitter, options: { fetchFunction: (url: string, init: { signal: AbortSignal }) => Promise<unknown> }) => unknown;
};

function setup(fetchFunction: (url: string, init: { signal: AbortSignal }) => Promise<unknown>) {
  const ipcMain = new EventEmitter();
  const sent: string[] = [];
  const sender = { isDestroyed: () => false, send: (channel: string) => sent.push(channel) };
  FetchMainHandler.init(ipcMain, { fetchFunction });
  ipcMain.emit("FetchBridge:Request", { sender }, "r1", { url: "https://example.org/a" });
  return { ipcMain, sent };
}

function response(body: EventEmitter) {
  return { status: 200, headers: new Map([["content-type", "text/plain"]]), body };
}

describe("electron Tor fetch handler", () => {
  // Regression: a mid-stream body error had no listener — an uncaught
  // exception in the Electron main process.
  it("turns a body stream error into an Error message", async () => {
    const body = new EventEmitter();
    const { sent } = setup(() => Promise.resolve(response(body)));
    await new Promise((r) => setTimeout(r, 0));
    expect(() => body.emit("error", new Error("socket hang up"))).not.toThrow();
    expect(sent).toContain("FetchBridge:r1:Error");
  });

  // Regression: onAbort registered no listener and was never called, so the
  // renderer's Abort did nothing and the request kept streaming.
  it("aborts the request when the renderer sends Abort", async () => {
    let signal: AbortSignal | undefined;
    const { ipcMain } = setup((_url, init) => {
      signal = init.signal;
      return new Promise(() => {});
    });
    ipcMain.emit("FetchBridge:r1:Abort");
    expect(signal?.aborted).toBe(true);
  });

  it("still streams a normal response to the end", async () => {
    const body = new EventEmitter();
    const { sent } = setup(() => Promise.resolve(response(body)));
    await new Promise((r) => setTimeout(r, 0));
    body.emit("data", Buffer.from("hi"));
    body.emit("end");
    expect(sent).toEqual(["FetchBridge:r1:InitialData", "FetchBridge:r1:Data", "FetchBridge:r1:End"]);
  });
});
