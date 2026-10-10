/**
 * Web Worker that hosts the Matrix SDK's IndexedDB sync store backend.
 *
 * With it the store's IndexedDB reads/writes, the sync accumulator and the
 * saved-sync load run off the main thread (no deepCopy of the whole cached
 * sync on startup). Created through sync-store-worker.ts, which falls back to
 * the main-thread store when this script can't run on the WebView.
 */

// MUST be first import — sets global/window/process before SDK modules load.
import "@/shared/lib/crypto-worker/worker-polyfills";

import { IndexedDBStoreWorker } from "matrix-js-sdk-bastyon/lib/indexeddb-worker.js";

const scope = self as unknown as Worker;
const remoteWorker = new IndexedDBStoreWorker(scope.postMessage.bind(scope));
scope.onmessage = remoteWorker.onMessage;
