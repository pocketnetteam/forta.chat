/**
 * CryptoBridge — main-thread proxy for the Crypto Web Worker.
 *
 * Provides Promise-based API for encrypt/decrypt operations.
 * All heavy crypto runs in the Worker; main thread never blocks.
 */

import type {
  WorkerRequest,
  WorkerResponse,
  DecryptRequest,
  EncryptRequest,
  DecryptFileRequest,
} from "./crypto.worker";

// ---------------------------------------------------------------------------
// Singleton worker
// ---------------------------------------------------------------------------

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

/** Set once the worker delivers ANY response — proof the script actually
 *  loaded and ran. Distinguishes a transient crash (keep using workers)
 *  from a script that can never load on this WebView (downgrade support,
 *  see onerror / WEE-92 N1). */
let workerEverResponded = false;

function getWorker(): Worker {
  if (!worker) {
    // Standard Vite worker — Vite bundles crypto.worker.ts as a separate chunk.
    // Polyfills (global, window, process) are handled inside the worker via
    // `import "./worker-polyfills"` as the first import in crypto.worker.ts.
    try {
      worker = new Worker(
        new URL("./crypto.worker.ts", import.meta.url),
        { type: "module" },
      );
    } catch (e) {
      console.error("[CryptoBridge] failed to create worker:", e);
      throw e;
    }
    worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      workerEverResponded = true;
      const { id, result, error } = e.data;
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      // Check presence, not truthiness: an empty error string (e.g. a
      // DOMException with no message) must still reject — treating it as
      // success would resolve with `undefined` and let corrupt data through
      // (WEE-92 C1).
      if (error !== undefined) {
        p.reject(new Error(error || "worker operation failed"));
      } else {
        p.resolve(result);
      }
    };
    worker.onerror = (e) => {
      console.error("[CryptoBridge] worker error:", e.message, e.filename, e.lineno);
      // Reject all pending requests so callers don't hang
      for (const [id, p] of pending) {
        p.reject(new Error("Worker error: " + e.message));
        pending.delete(id);
      }
      // Drop the broken instance. On WebViews where the module-worker script
      // fails to LOAD (async — the constructor itself succeeds), a kept-alive
      // dead worker would swallow every later postMessage without ever
      // settling it: each request then burns its full caller-side timeout
      // with no fallback (WEE-92 H1). Re-creating per send keeps the failure
      // fast and lets callers' infra-error fallback fire instead.
      try { worker?.terminate(); } catch { /* already dead */ }
      worker = null;
      // If the worker NEVER produced a response, the script most likely can't
      // load on this WebView at all (e.g. classic-worker engines ignoring
      // type:"module") — every future attempt would also fail. Downgrade the
      // support verdict so policy call sites (runFileDecrypt) return to the
      // serial main-thread queue instead of burning a worker construction +
      // infra-fallback per attachment forever (WEE-92 N1). A worker that has
      // responded before just crashed transiently — keep support on.
      if (!workerEverResponded) workerSupported = false;
    };
  }
  return worker;
}

function send<T>(msg: Omit<WorkerRequest, "id">, transfer?: Transferable[]): Promise<T> {
  return new Promise((resolve, reject) => {
    // Construct the worker BEFORE registering the pending entry: a throwing
    // constructor (e.g. re-creation after H1 teardown) must not leak a
    // never-settled entry in `pending`, and the rejection carries the infra
    // prefix so callers' fallback classification fires.
    let w: Worker;
    try {
      w = getWorker();
    } catch (e) {
      reject(new Error("Worker error: " + (e instanceof Error ? e.message : String(e))));
      return;
    }
    const id = nextId++;
    pending.set(id, {
      resolve: resolve as (v: unknown) => void,
      reject,
    });
    // Transferables (large media buffers) move ownership instead of being
    // structured-cloned — the caller's buffer is detached after this call.
    w.postMessage({ ...msg, id }, transfer ?? []);
  });
}

/** Matches the bridge's own infrastructure failures ("Worker error: ...",
 *  "Worker terminated") as opposed to application errors forwarded from the
 *  worker (e.g. a deterministic decrypt failure). The prefix and this
 *  classifier live together in this module so they can't drift apart. */
const WORKER_INFRA_ERROR_RE = /^Worker (error|terminated)/;

/** True for failures of the worker INFRASTRUCTURE (died, terminated,
 *  failed to load) — the operation may succeed elsewhere (e.g. a
 *  main-thread fallback). False for application errors the worker
 *  computed deterministically (wrong key, corrupt ciphertext): retrying
 *  those on another thread would fail identically. */
export function isWorkerInfraError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return WORKER_INFRA_ERROR_RE.test(msg);
}

/** True when a module Web Worker can be constructed in this environment.
 *  Lazily probes once (by creating the singleton worker) and caches the
 *  verdict — call sites use it to choose between the parallel worker path
 *  and the legacy sequential main-thread fallback (WEE-92). */
let workerSupported: boolean | null = null;
export function isCryptoWorkerSupported(): boolean {
  if (workerSupported === null) {
    try {
      getWorker();
      workerSupported = true;
    } catch {
      workerSupported = false;
    }
  }
  return workerSupported;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface CryptoUser {
  id: string;
  keys: string[];
}

/**
 * Decrypt a message in the Worker thread.
 * Returns the decrypted plaintext string.
 */
export function workerDecrypt(params: {
  users: CryptoUser[];
  myId: string;
  privateKeys: string[];
  targetUserId: string;
  encData: { encrypted: string; nonce: string };
  time: number;
  block: number;
}): Promise<string> {
  return send<string>({
    type: "decrypt",
    ...params,
  } as Omit<DecryptRequest, "id">);
}

/**
 * Encrypt a message in the Worker thread.
 * Returns { encrypted, nonce } for AES-SIV.
 */
export function workerEncrypt(params: {
  users: CryptoUser[];
  myId: string;
  privateKeys: string[];
  targetUserId: string;
  text: string;
  time: number;
  block: number;
}): Promise<{ encrypted: string; nonce: string }> {
  return send<{ encrypted: string; nonce: string }>({
    type: "encrypt",
    ...params,
  } as Omit<EncryptRequest, "id">);
}

/**
 * Decrypt a file attachment (PBKDF2 + AES-CBC) in the Worker thread.
 * The input buffer is TRANSFERRED (detached) — pass a copy if the caller
 * still needs it. Returns the decrypted bytes (also transferred, zero-copy).
 */
export function workerDecryptFile(
  data: ArrayBuffer,
  secret: string,
): Promise<ArrayBuffer> {
  return send<ArrayBuffer>(
    { type: "decryptFile", data, secret } as Omit<DecryptFileRequest, "id">,
    [data],
  );
}

/**
 * Terminate the worker (e.g. on logout).
 */
export function terminateCryptoWorker(): void {
  if (worker) {
    worker.terminate();
    worker = null;
    for (const p of pending.values()) {
      p.reject(new Error("Worker terminated"));
    }
    pending.clear();
  }
}
