import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * WEE-92 — bridge protocol for the file-decrypt worker path.
 *
 * Real Workers don't exist in the test DOM, so we stub `globalThis.Worker`
 * with a fake that records postMessage calls and lets each test script the
 * response. This verifies the bridge contract: request shape, transferable
 * list, resolve/reject mapping, and the isCryptoWorkerSupported probe.
 */

type Posted = { msg: Record<string, unknown>; transfer: Transferable[] };

class FakeWorker {
  static instances: FakeWorker[] = [];
  static failConstruction = false;
  posted: Posted[] = [];
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: ((e: { message: string; filename?: string; lineno?: number }) => void) | null = null;

  constructor() {
    if (FakeWorker.failConstruction) throw new Error("no workers here");
    FakeWorker.instances.push(this);
  }

  postMessage(msg: Record<string, unknown>, transfer: Transferable[] = []) {
    this.posted.push({ msg, transfer });
  }

  reply(id: number, payload: { result?: unknown; error?: string }) {
    this.onmessage?.({ data: { id, ...payload } });
  }

  terminate() { /* noop */ }
}

async function loadBridge() {
  vi.resetModules();
  return import("./bridge");
}

beforeEach(() => {
  FakeWorker.instances = [];
  FakeWorker.failConstruction = false;
  vi.stubGlobal("Worker", FakeWorker as unknown as typeof Worker);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("bridge — workerDecryptFile (WEE-92)", () => {
  it("posts a decryptFile request and transfers the input buffer", async () => {
    const { workerDecryptFile } = await loadBridge();
    const data = new Uint8Array([1, 2, 3]).buffer;

    void workerDecryptFile(data, "secret");
    const w = FakeWorker.instances[0];
    expect(w.posted).toHaveLength(1);

    const { msg, transfer } = w.posted[0];
    expect(msg.type).toBe("decryptFile");
    expect(msg.secret).toBe("secret");
    expect(msg.data).toBe(data);
    // Zero-copy contract: the input buffer must be in the transfer list.
    expect(transfer).toContain(data);
  });

  it("resolves with the worker's result buffer", async () => {
    const { workerDecryptFile } = await loadBridge();
    const p = workerDecryptFile(new ArrayBuffer(4), "s");

    const w = FakeWorker.instances[0];
    const id = w.posted[0].msg.id as number;
    const decrypted = new Uint8Array([9, 9]).buffer;
    w.reply(id, { result: decrypted });

    await expect(p).resolves.toBe(decrypted);
  });

  it("rejects when the worker reports an error", async () => {
    const { workerDecryptFile } = await loadBridge();
    const p = workerDecryptFile(new ArrayBuffer(4), "s");

    const w = FakeWorker.instances[0];
    const id = w.posted[0].msg.id as number;
    w.reply(id, { error: "OperationError" });

    await expect(p).rejects.toThrow("OperationError");
  });

  it("rejects pending requests when the worker errors out", async () => {
    const { workerDecryptFile } = await loadBridge();
    const p = workerDecryptFile(new ArrayBuffer(4), "s");

    const w = FakeWorker.instances[0];
    w.onerror?.({ message: "boom" });

    // Bridge prefixes infra failures with "Worker error" — the
    // isWorkerInfraError classifier keys off this exact prefix.
    await expect(p).rejects.toThrow(/^Worker error/);
  });

  it("REJECTS on an empty error string instead of resolving undefined (C1)", async () => {
    // WebCrypto's OperationError often has an empty message. Treating "" as
    // success would resolve `undefined`, wrap it into a File containing the
    // text "undefined", and poison the media cache with corrupt bytes.
    const { workerDecryptFile } = await loadBridge();
    const p = workerDecryptFile(new ArrayBuffer(4), "s");

    const w = FakeWorker.instances[0];
    const id = w.posted[0].msg.id as number;
    w.reply(id, { error: "" });

    await expect(p).rejects.toThrow("worker operation failed");
  });

  it("drops the dead worker after onerror so the next send re-creates it (H1)", async () => {
    // On WebViews where the module-worker script fails to LOAD (async, after
    // a successful constructor), keeping the dead instance would swallow
    // every later request: it never settles and burns the caller's full
    // timeout with no infra-error fallback.
    const { workerDecryptFile } = await loadBridge();
    void workerDecryptFile(new ArrayBuffer(4), "s").catch(() => undefined);
    expect(FakeWorker.instances).toHaveLength(1);

    FakeWorker.instances[0].onerror?.({ message: "load failed" });

    void workerDecryptFile(new ArrayBuffer(4), "s").catch(() => undefined);
    // A fresh worker instance — the request lands on a live onerror/onmessage
    // pair and fails fast instead of hanging.
    expect(FakeWorker.instances).toHaveLength(2);
  });
});

describe("bridge — isWorkerInfraError (WEE-92)", () => {
  it("classifies bridge infra failures as infra", async () => {
    const { isWorkerInfraError } = await loadBridge();
    expect(isWorkerInfraError(new Error("Worker error: boom"))).toBe(true);
    expect(isWorkerInfraError(new Error("Worker terminated"))).toBe(true);
  });

  it("classifies application errors as non-infra (no main-thread retry)", async () => {
    const { isWorkerInfraError } = await loadBridge();
    expect(isWorkerInfraError(new Error("OperationError"))).toBe(false);
    expect(isWorkerInfraError(new Error("worker operation failed"))).toBe(false);
    expect(isWorkerInfraError(new Error("decryptFile timed out after 60000ms"))).toBe(false);
  });
});

describe("bridge — isCryptoWorkerSupported (WEE-92)", () => {
  it("returns true when a Worker can be constructed (and caches)", async () => {
    const { isCryptoWorkerSupported } = await loadBridge();
    expect(isCryptoWorkerSupported()).toBe(true);
    expect(isCryptoWorkerSupported()).toBe(true);
    // Probe reuses the singleton — exactly one Worker constructed.
    expect(FakeWorker.instances).toHaveLength(1);
  });

  it("returns false when Worker construction throws", async () => {
    FakeWorker.failConstruction = true;
    const { isCryptoWorkerSupported } = await loadBridge();
    expect(isCryptoWorkerSupported()).toBe(false);
  });

  it("downgrades to false after onerror with NO prior successful response (N1)", async () => {
    // Module-worker script that can never load (old WebViews ignoring
    // type:"module"): constructor succeeds, load fails async. Keeping
    // `supported=true` would bypass the serial freeze guard forever while
    // every request burns a worker construction + infra fallback.
    const { isCryptoWorkerSupported, workerDecryptFile } = await loadBridge();
    expect(isCryptoWorkerSupported()).toBe(true);

    void workerDecryptFile(new ArrayBuffer(4), "s").catch(() => undefined);
    FakeWorker.instances[0].onerror?.({ message: "script load failed" });

    expect(isCryptoWorkerSupported()).toBe(false);
  });

  it("keeps support after onerror when the worker HAS responded before (transient crash)", async () => {
    const { isCryptoWorkerSupported, workerDecryptFile } = await loadBridge();

    // First request succeeds — proves the script loads on this engine.
    const p = workerDecryptFile(new ArrayBuffer(4), "s");
    const w = FakeWorker.instances[0];
    w.reply(w.posted[0].msg.id as number, { result: new ArrayBuffer(1) });
    await p;

    w.onerror?.({ message: "transient crash" });
    expect(isCryptoWorkerSupported()).toBe(true);
  });
});
