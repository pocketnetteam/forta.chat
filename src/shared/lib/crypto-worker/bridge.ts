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
} from "./crypto.worker";

// ---------------------------------------------------------------------------
// Singleton worker
// ---------------------------------------------------------------------------

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

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
      const { id, result, error } = e.data;
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      if (error) {
        p.reject(new Error(error));
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
    };
  }
  return worker;
}

function send<T>(msg: Omit<WorkerRequest, "id">): Promise<T> {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, {
      resolve: resolve as (v: unknown) => void,
      reject,
    });
    getWorker().postMessage({ ...msg, id });
  });
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
