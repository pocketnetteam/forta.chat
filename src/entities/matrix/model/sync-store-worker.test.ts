import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  GuardedStoreWorker,
  probeSyncStoreWorker,
  releaseSyncStoreWorker,
  trackSyncStoreWorker,
} from "./sync-store-worker";

type Reply = { command: string; seq: number };

/** Minimal Worker stand-in: records posted messages, lets the test answer. */
class FakeWorker {
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  posted: unknown[] = [];
  terminate = vi.fn();
  postMessage(msg: unknown): void {
    this.posted.push(msg);
  }
  reply(data: Reply): void {
    this.onmessage?.({ data } as MessageEvent);
  }
  fail(message: string): void {
    this.onerror?.({ message } as ErrorEvent);
  }
}

describe("probeSyncStoreWorker", () => {
  let worker: FakeWorker;
  const create = (): Worker => worker as unknown as Worker;

  beforeEach(() => {
    worker = new FakeWorker();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("asks the worker to set up its backend without opening a database", () => {
    void probeSyncStoreWorker(create);
    expect(worker.posted).toEqual([{ command: "setupWorker", seq: -1, args: [] }]);
  });

  it("is supported when the worker answers the probe, and the probe worker is stopped", async () => {
    const verdict = probeSyncStoreWorker(create);
    worker.reply({ command: "cmd_success", seq: -1 });
    await expect(verdict).resolves.toBe(true);
    expect(worker.terminate).toHaveBeenCalled();
  });

  it("ignores replies to other commands", async () => {
    vi.useFakeTimers();
    const verdict = probeSyncStoreWorker(create, 1000);
    worker.reply({ command: "cmd_success", seq: 0 });
    vi.advanceTimersByTime(1000);
    await expect(verdict).resolves.toBe(false);
  });

  it("is unsupported when the worker script fails (no IndexedDB in the worker, bad script)", async () => {
    const verdict = probeSyncStoreWorker(create);
    worker.fail("indexedDB is not defined");
    await expect(verdict).resolves.toBe(false);
    expect(worker.terminate).toHaveBeenCalled();
  });

  it("is unsupported when the worker rejects the command", async () => {
    const verdict = probeSyncStoreWorker(create);
    worker.reply({ command: "cmd_fail", seq: -1 });
    await expect(verdict).resolves.toBe(false);
  });

  it("is unsupported when the worker never answers (module script ignored by the WebView)", async () => {
    vi.useFakeTimers();
    const verdict = probeSyncStoreWorker(create, 1000);
    vi.advanceTimersByTime(1000);
    await expect(verdict).resolves.toBe(false);
    expect(worker.terminate).toHaveBeenCalled();
  });

  it("is unsupported when the Worker constructor throws (e.g. file:// origin)", async () => {
    const verdict = probeSyncStoreWorker(() => {
      throw new Error("SecurityError");
    });
    await expect(verdict).resolves.toBe(false);
  });

  it("settles once: a late error after success does not flip the verdict", async () => {
    const verdict = probeSyncStoreWorker(create);
    worker.reply({ command: "cmd_success", seq: -1 });
    worker.fail("late");
    await expect(verdict).resolves.toBe(true);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });
});

describe("isSyncStoreWorkerSupported", () => {
  let spawned: FakeWorker[];
  let storage: Map<string, string>;

  beforeEach(() => {
    vi.resetModules();
    spawned = [];
    storage = new Map();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("Worker", class extends FakeWorker {
      constructor() {
        super();
        spawned.push(this);
      }
    });
    vi.stubGlobal("indexedDB", {});
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => void storage.set(k, v),
    });
    vi.stubGlobal("navigator", { userAgent: "WebView/60" });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("is false without Worker support, without spawning anything", async () => {
    vi.stubGlobal("Worker", undefined);
    const mod = await import("./sync-store-worker");
    await expect(mod.isSyncStoreWorkerSupported()).resolves.toBe(false);
  });

  it("probes once per session", async () => {
    const mod = await import("./sync-store-worker");
    const first = mod.isSyncStoreWorkerSupported();
    spawned[0].reply({ command: "cmd_success", seq: -1 });
    await expect(first).resolves.toBe(true);
    await expect(mod.isSyncStoreWorkerSupported()).resolves.toBe(true);
    expect(spawned).toHaveLength(1);
  });

  it("remembers a failed probe for this WebView and skips the probe on the next launch", async () => {
    const mod = await import("./sync-store-worker");
    const verdict = mod.isSyncStoreWorkerSupported();
    spawned[0].fail("cannot load");
    await expect(verdict).resolves.toBe(false);

    vi.resetModules(); // next launch
    const next = await import("./sync-store-worker");
    await expect(next.isSyncStoreWorkerSupported()).resolves.toBe(false);
    expect(spawned).toHaveLength(1);
  });

  it("probes again after the WebView updates", async () => {
    storage.set("matrix-sync-store-worker-unsupported-ua", "WebView/59");
    const mod = await import("./sync-store-worker");
    void mod.isSyncStoreWorkerSupported();
    expect(spawned).toHaveLength(1);
  });

  it("falls back to the main-thread store for later builds after the store worker fails", async () => {
    const mod = await import("./sync-store-worker");
    const verdict = mod.isSyncStoreWorkerSupported();
    spawned[0].reply({ command: "cmd_success", seq: -1 });
    await expect(verdict).resolves.toBe(true);

    vi.spyOn(console, "error").mockImplementation(() => {});
    mod.startSyncStoreWorker();
    spawned[1].fail("out of memory");

    await expect(mod.isSyncStoreWorkerSupported()).resolves.toBe(false);
    // A runtime crash is not a WebView verdict: the next launch probes again.
    expect(storage.size).toBe(0);
  });
});

describe("GuardedStoreWorker", () => {
  let raw: FakeWorker;
  let guarded: GuardedStoreWorker;
  let replies: Reply[];

  beforeEach(() => {
    raw = new FakeWorker();
    guarded = new GuardedStoreWorker(raw as unknown as Worker);
    replies = [];
    guarded.onmessage = (e) => replies.push(e.data as Reply);
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const flushReplies = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

  it("passes commands and replies through", () => {
    guarded.postMessage({ command: "getSavedSync", seq: 0 });
    raw.reply({ command: "cmd_success", seq: 0 });
    expect(raw.posted).toEqual([{ command: "getSavedSync", seq: 0 }]);
    expect(replies).toEqual([{ command: "cmd_success", seq: 0 }]);
  });

  it("fails pending and later commands when the worker dies, so the SDK store degrades instead of hanging", async () => {
    guarded.postMessage({ command: "setSyncData", seq: 0 });
    guarded.postMessage({ command: "syncToDatabase", seq: 1 });
    raw.fail("out of memory");
    guarded.postMessage({ command: "clearDatabase", seq: 2 });
    await flushReplies();

    expect(replies.map((r) => [r.command, r.seq])).toEqual([
      ["cmd_fail", 0],
      ["cmd_fail", 1],
      ["cmd_fail", 2],
    ]);
    // RemoteIndexedDBStoreBackend builds its Error from error.message
    expect((replies[0] as unknown as { error: { message: string } }).error.message).toBeTruthy();
    expect(raw.terminate).toHaveBeenCalled();
    expect(raw.posted).toHaveLength(2);
  });

  it("terminate() waits for an in-flight save before stopping the worker", () => {
    guarded.postMessage({ command: "syncToDatabase", seq: 0 });
    guarded.terminate();
    expect(raw.terminate).not.toHaveBeenCalled();

    raw.reply({ command: "cmd_success", seq: 0 });
    expect(replies).toHaveLength(1);
    expect(raw.terminate).toHaveBeenCalledTimes(1);
  });

  it("terminate() gives up waiting after the drain timeout", () => {
    vi.useFakeTimers();
    guarded.postMessage({ command: "syncToDatabase", seq: 0 });
    guarded.terminate();
    vi.advanceTimersByTime(10_000);
    expect(raw.terminate).toHaveBeenCalledTimes(1);
  });

  it("terminate() stops an idle worker at once", () => {
    guarded.terminate();
    expect(raw.terminate).toHaveBeenCalledTimes(1);
  });
});

describe("releaseSyncStoreWorker", () => {
  it("destroys a tracked worker store once", () => {
    const store = { destroy: vi.fn(async () => {}) };
    trackSyncStoreWorker(store);
    releaseSyncStoreWorker(store);
    releaseSyncStoreWorker(store);
    expect(store.destroy).toHaveBeenCalledTimes(1);
  });

  it("leaves a main-thread store open", () => {
    const store = { destroy: vi.fn(async () => {}) };
    releaseSyncStoreWorker(store);
    expect(store.destroy).not.toHaveBeenCalled();
  });

  it("tolerates a missing store", () => {
    expect(() => releaseSyncStoreWorker(undefined)).not.toThrow();
    expect(() => releaseSyncStoreWorker(null)).not.toThrow();
  });
});
