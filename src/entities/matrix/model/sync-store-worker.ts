/**
 * Runs the Matrix SDK's IndexedDB sync store in a Web Worker when this
 * WebView supports it; otherwise the store stays on the main thread as before.
 *
 * On a large account the main-thread store spends ~0.5 s of startup on the
 * main thread: reading the saved sync from IndexedDB and deep-copying it
 * (JSON stringify + parse) before syncFromCache. In the worker both happen off
 * the main thread, and so does accumulating every later /sync response.
 *
 * The SDK's remote backend never times out: if the worker script fails to
 * load (async, the constructor itself succeeds — see WEE-92 in
 * crypto-worker/bridge.ts) or dies later, every store command would hang and
 * the sync loop with it. So the worker is probed before the store is built on
 * it, and GuardedStoreWorker turns a dead worker into failed commands.
 */

const PROBE_TIMEOUT_MS = 5_000;
/** Max wait for in-flight store writes when a dropped client's worker is stopped. */
const DRAIN_TIMEOUT_MS = 10_000;
/** The SDK backend numbers its commands from 0; the probe never collides. */
const PROBE_SEQ = -1;
/** userAgent of a WebView where the probe failed — skip the probe (and its
 *  timeout) on later launches until the WebView updates. */
const UNSUPPORTED_UA_KEY = "matrix-sync-store-worker-unsupported-ua";

interface StoreWorkerMessage {
  command?: string;
  seq?: number;
}

let supportVerdict: Promise<boolean> | null = null;
const workerStores = new WeakSet<object>();

function createSyncStoreWorker(): Worker {
  return new Worker(new URL("./sync-store.worker.ts", import.meta.url), { type: "module" });
}

/**
 * Stands between the SDK's RemoteIndexedDBStoreBackend and the worker.
 * - The worker fails (error event): every pending and later command gets a
 *   `cmd_fail` reply, so the SDK's degradable store falls back to MemoryStore
 *   as it does when a main-thread store fails, instead of hanging the sync loop.
 * - terminate() lets in-flight commands (a save writes several IndexedDB
 *   transactions) finish first, up to DRAIN_TIMEOUT_MS.
 */
export class GuardedStoreWorker {
  onmessage: ((e: MessageEvent) => void) | null = null;
  private readonly pending = new Set<number>();
  private failed = false;
  private onDrained: (() => void) | null = null;

  constructor(private readonly worker: Worker) {
    worker.onmessage = (e: MessageEvent<StoreWorkerMessage>) => {
      const seq = e.data?.seq;
      this.onmessage?.(e);
      if (typeof seq === "number") this.settle(seq);
    };
    worker.onerror = (e) => this.fail(e.message || "worker error");
  }

  postMessage(msg: { command: string; seq: number; args?: unknown[] }): void {
    if (this.failed) {
      this.replyFail(msg.seq);
      return;
    }
    this.pending.add(msg.seq);
    try {
      this.worker.postMessage(msg);
    } catch (e) {
      this.pending.delete(msg.seq);
      throw e;
    }
  }

  terminate(): void {
    if (this.failed || this.pending.size === 0) {
      this.worker.terminate();
      return;
    }
    const timer = setTimeout(() => {
      this.onDrained = null;
      this.worker.terminate();
    }, DRAIN_TIMEOUT_MS);
    this.onDrained = () => {
      clearTimeout(timer);
      this.worker.terminate();
    };
  }

  private settle(seq: number): void {
    this.pending.delete(seq);
    if (this.pending.size === 0 && this.onDrained) {
      const drained = this.onDrained;
      this.onDrained = null;
      drained();
    }
  }

  private fail(reason: string): void {
    if (this.failed) return;
    this.failed = true;
    console.error("[matrix] sync store worker failed, store degrades to memory:", reason);
    // Later client builds this session go back to the main-thread store.
    supportVerdict = Promise.resolve(false);
    try { this.worker.terminate(); } catch { /* already dead */ }
    this.onDrained = null;
    const pending = [...this.pending];
    this.pending.clear();
    for (const seq of pending) this.replyFail(seq);
  }

  private replyFail(seq: number): void {
    // Async, like a real reply: the SDK registers the command before posting it.
    void Promise.resolve().then(() => {
      this.onmessage?.({
        data: { command: "cmd_fail", seq, error: { name: "Error", message: "Sync store worker failed" } },
      } as MessageEvent);
    });
  }
}

/** Worker factory for `IndexedDBStore({ workerFactory })`. */
export function startSyncStoreWorker(): Worker {
  return new GuardedStoreWorker(createSyncStoreWorker()) as unknown as Worker;
}

/**
 * Starts a worker from `create` and asks it to set up its store backend.
 * True only when the worker answers: proves the script loaded on this WebView
 * and that `indexedDB` exists inside the worker (setupWorker reads it). Opens
 * no database; the probe worker is always terminated.
 */
export function probeSyncStoreWorker(
  create: () => Worker,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    let worker: Worker | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (supported: boolean, reason?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { worker?.terminate(); } catch { /* already dead */ }
      if (!supported) {
        console.warn("[matrix] sync store worker unavailable, using the main-thread store:", reason);
      }
      resolve(supported);
    };

    timer = setTimeout(() => finish(false, "no reply"), timeoutMs);
    try {
      worker = create();
    } catch (e) {
      finish(false, e);
      return;
    }
    worker.onmessage = (e: MessageEvent<StoreWorkerMessage>) => {
      if (e.data?.seq !== PROBE_SEQ) return;
      if (e.data.command === "cmd_success") finish(true);
      else finish(false, e.data);
    };
    worker.onerror = (e) => finish(false, e.message || "worker error");
    worker.onmessageerror = () => finish(false, "messageerror");
    try {
      worker.postMessage({ command: "setupWorker", seq: PROBE_SEQ, args: [] });
    } catch (e) {
      finish(false, e);
    }
  });
}

function isMarkedUnsupported(): boolean {
  try {
    return localStorage.getItem(UNSUPPORTED_UA_KEY) === navigator.userAgent;
  } catch {
    return false;
  }
}

function markUnsupported(): void {
  try {
    localStorage.setItem(UNSUPPORTED_UA_KEY, navigator.userAgent);
  } catch { /* storage unavailable — probe again next launch */ }
}

/** Probe verdict, computed once per session; a failed probe is remembered per WebView version. */
export function isSyncStoreWorkerSupported(): Promise<boolean> {
  if (typeof Worker === "undefined" || typeof indexedDB === "undefined" || isMarkedUnsupported()) {
    return Promise.resolve(false);
  }
  supportVerdict ??= probeSyncStoreWorker(createSyncStoreWorker).then((supported) => {
    if (!supported) markUnsupported();
    return supported;
  });
  return supportVerdict;
}

/** Remember a store built on the worker so releaseSyncStoreWorker can stop it. */
export function trackSyncStoreWorker(store: object): void {
  workerStores.add(store);
}

/**
 * Stop the worker behind a dropped client's store. The SDK's stopClient
 * leaves the store alone, so without this every rebuilt client (failover,
 * re-login) would leave a worker running. The worker finishes in-flight
 * writes first (GuardedStoreWorker.terminate). A main-thread store is left as
 * it was: closing its database under an in-flight save would make the SDK
 * degrade and wipe the cache.
 */
export function releaseSyncStoreWorker(store: unknown): void {
  if (!store || typeof store !== "object" || !workerStores.has(store)) return;
  workerStores.delete(store);
  const destroy = (store as { destroy?: () => Promise<void> }).destroy;
  if (typeof destroy !== "function") return;
  destroy.call(store).catch((e: unknown) => {
    console.warn("[matrix] failed to stop the sync store worker:", e);
  });
}
