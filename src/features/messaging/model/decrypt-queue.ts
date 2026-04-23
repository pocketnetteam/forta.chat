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

let tail: Promise<unknown> = Promise.resolve();

/** Enqueue `task` behind every previously-enqueued decrypt task. Returns
 *  a promise that resolves/rejects with the task's result. Failures do
 *  NOT poison the chain — the next enqueue runs regardless. */
export function enqueueDecrypt<T>(task: () => Promise<T>): Promise<T> {
  const run = tail.then(task, task);
  // Swallow rejections on the shared tail so a failure doesn't pollute
  // the chain. Consumers still see the rejection via the returned
  // promise (`run`), which is not the same object.
  tail = run.catch(() => undefined);
  return run;
}
