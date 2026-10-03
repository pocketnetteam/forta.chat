import { describe, it, expect, vi, afterEach } from "vitest";

const instances: Array<{ postMessage: (msg: unknown) => void; onMessage: () => void }> = [];

vi.mock("matrix-js-sdk-bastyon/lib/indexeddb-worker.js", () => ({
  IndexedDBStoreWorker: class {
    onMessage = vi.fn();
    constructor(public postMessage: (msg: unknown) => void) {
      instances.push(this);
    }
  },
}));

describe("sync-store.worker entry", () => {
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).self;
  });

  it("routes worker messages to the SDK store worker and its replies back to the main thread", async () => {
    const scope = {
      onmessage: null as unknown,
      posted: [] as unknown[],
      postMessage(this: { posted: unknown[] }, msg: unknown) {
        // Must be called with the worker scope as `this` (Illegal invocation otherwise)
        this.posted.push(msg);
      },
    };
    (globalThis as Record<string, unknown>).self = scope;

    await import("./sync-store.worker");

    expect(instances).toHaveLength(1);
    expect(scope.onmessage).toBe(instances[0].onMessage);
    // The SDK calls postMessage.call(null, ...) — the bound scope must survive that
    instances[0].postMessage.call(null, { command: "cmd_success", seq: 0 });
    expect(scope.posted).toEqual([{ command: "cmd_success", seq: 0 }]);
  });
});
