/**
 * Sequential queue for file-decrypt tasks.
 *
 * Running decryptFile on many inbound attachments concurrently saturates
 * the CPU on older Android WebViews (observed freezes on Xiaomi Android 7
 * and similar low-end devices, see bug reports #306, #370). Serialising
 * the work keeps the main thread responsive — decryption on one file
 * usually finishes fast enough that the user-perceived lag is fine.
 *
 * Mirrors bastyon-chat's `decryptFileQueue` / `f.processArray` pattern
 * (src/application/pcrypto.js:1256-1273).
 */

import { withTimeout } from "@/shared/lib/with-timeout";
import { isCryptoWorkerSupported } from "@/shared/lib/crypto-worker/bridge";

/** Hard ceiling for a single decrypt task. The queue is strictly serial, so a
 *  task that never settles (e.g. a worker that hangs, or an upstream promise
 *  that never resolves) would wedge `tail` permanently — every later attachment
 *  then waits behind it forever and no media in the chat ever decrypts
 *  (WEE-90 H4). Bounding each task lets the chain advance: the stuck task
 *  rejects with a timeout, its consumer surfaces error+retry, and the next
 *  enqueued task runs. 60s is generous for a large file on a slow Android
 *  WebView while still being finite. Note: withTimeout does NOT cancel the
 *  underlying task — a wedged decrypt keeps running in the background, so in
 *  the (rare) timeout case it can briefly overlap the next task; acceptable
 *  versus a permanently frozen queue. */
const DECRYPT_TASK_TIMEOUT_MS = 60_000;

let tail: Promise<unknown> = Promise.resolve();

/** Enqueue `task` behind every previously-enqueued decrypt task. Returns
 *  a promise that resolves/rejects with the task's result. Failures do
 *  NOT poison the chain — the next enqueue runs regardless. Each task is
 *  bounded by DECRYPT_TASK_TIMEOUT_MS so one stuck decrypt can't block the
 *  whole chain (WEE-90 H4). */
export function enqueueDecrypt<T>(task: () => Promise<T>): Promise<T> {
  const bounded = () => withTimeout(task(), DECRYPT_TASK_TIMEOUT_MS, "decryptFile");
  const run = tail.then(bounded, bounded);
  // Swallow rejections on the shared tail so a failure doesn't pollute
  // the chain. Consumers still see the rejection via the returned
  // promise (`run`), which is not the same object.
  tail = run.catch(() => undefined);
  return run;
}

/** Files at or above this size stay on the serial queue even when the
 *  worker is available. A decrypt holds ciphertext + plaintext (~2× file
 *  size) in memory; three concurrent 100 MB videos would spike ~600 MB of
 *  transient buffers — OOM-kill territory on the same low-end devices this
 *  feature targets. Photos and voice notes (the latency-sensitive bulk of
 *  chat media) sit far below this line and still parallelise. */
const LARGE_FILE_SERIAL_THRESHOLD_BYTES = 32 * 1024 * 1024;

/** Run a file-decrypt task with the right concurrency policy (WEE-92).
 *
 *  With the crypto Web Worker available, decryption runs OFF the main
 *  thread — the reason for serialising (#306/#370 main-thread freezes) is
 *  gone, so tasks run in parallel. Effective parallelism is still capped by
 *  `mediaDownloadGate` in use-file-download (its permit covers fetch +
 *  decrypt), so a media-heavy chat can't stampede the worker. The same
 *  per-task timeout applies: a wedged worker call surfaces error+retry
 *  instead of an eternal spinner (WEE-90 H4).
 *
 *  Large files (≥ LARGE_FILE_SERIAL_THRESHOLD_BYTES) and environments
 *  without worker support (exotic WebViews, worker construction failed)
 *  keep the legacy strictly-serial queue — for memory pressure and the
 *  #306/#370 main-thread freeze guard respectively. */
export function runFileDecrypt<T>(
  task: () => Promise<T>,
  opts?: { sizeBytes?: number },
): Promise<T> {
  const isLarge = (opts?.sizeBytes ?? 0) >= LARGE_FILE_SERIAL_THRESHOLD_BYTES;
  if (isCryptoWorkerSupported() && !isLarge) {
    return withTimeout(task(), DECRYPT_TASK_TIMEOUT_MS, "decryptFile");
  }
  return enqueueDecrypt(task);
}
