/**
 * Coalesces a *burst* of items into a single flush once the burst settles.
 *
 * WHY: rAF/microtask coalescing (see patch-scheduler.ts) only merges writes that
 * land in the same frame. When work trickles in — e.g. a chat backlog where each
 * Matrix event is decrypted and written one at a time, ~1 per flush window — each
 * item lands in its own frame, so the downstream re-render (sidebar re-sort) fires
 * per item. That is the "every message reorders the chat list" jank when opening a
 * room after being away.
 *
 * This coalescer waits for the stream to go quiet for `settleMs` before flushing,
 * so a whole backlog collapses into a single re-sort. A `maxWaitMs` cap guarantees
 * that a never-ending stream still flushes periodically instead of starving.
 *
 * Timers use the global setTimeout so tests can drive them with fake timers.
 */
export interface BurstCoalescer<T> {
  /** Append items to the pending burst and (re)arm the settle timer. */
  push(items: readonly T[]): void;
  /** Flush any pending items immediately (no-op when empty). */
  flush(): void;
  /** Drop pending items and cancel timers without flushing. */
  cancel(): void;
}

export interface BurstCoalescerOptions {
  /** Quiet period after the last `push` before flushing (ms). */
  settleMs: number;
  /** Hard cap from the first push of a burst, so long streams still flush (ms). */
  maxWaitMs: number;
}

export function createBurstCoalescer<T>(
  flush: (batch: T[]) => void,
  opts: BurstCoalescerOptions,
): BurstCoalescer<T> {
  let pending: T[] = [];
  let settleTimer: ReturnType<typeof setTimeout> | null = null;
  let maxWaitTimer: ReturnType<typeof setTimeout> | null = null;

  const clearTimers = () => {
    if (settleTimer !== null) {
      clearTimeout(settleTimer);
      settleTimer = null;
    }
    if (maxWaitTimer !== null) {
      clearTimeout(maxWaitTimer);
      maxWaitTimer = null;
    }
  };

  const doFlush = () => {
    clearTimers();
    if (pending.length === 0) return;
    const batch = pending;
    pending = [];
    flush(batch);
  };

  return {
    push(items) {
      if (items.length === 0) return;
      pending.push(...items);
      // Trailing debounce: reset the settle timer on every push.
      if (settleTimer !== null) clearTimeout(settleTimer);
      settleTimer = setTimeout(doFlush, opts.settleMs);
      // Max-wait starts on the first push of the burst and is NOT reset,
      // so a continuous stream still flushes at least every maxWaitMs.
      if (maxWaitTimer === null) {
        maxWaitTimer = setTimeout(doFlush, opts.maxWaitMs);
      }
    },
    flush: doFlush,
    cancel() {
      clearTimers();
      pending = [];
    },
  };
}
