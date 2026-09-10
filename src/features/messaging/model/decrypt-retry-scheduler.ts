/**
 * Bounded scheduler for automatic decrypt retries of "[encrypted]" bubbles.
 *
 * Opening a room with many stuck messages used to fire one
 * `decryptMessageNow` per mounted bubble at once, competing with the first
 * paint. Requests are now:
 * - limited to `concurrency` in flight;
 * - served newest-request-first (LIFO) — the bubble that just scrolled into
 *   view is what the user is looking at, older requests may be off-screen;
 * - deduplicated per eventId;
 * - suppressed for `cooldownMs` after a failed attempt, so a bubble that
 *   re-enters the viewport retries again later instead of never (the old
 *   one-shot flag) or on every scroll jitter.
 */
export interface DecryptRetryScheduler {
  /** Queue an automatic attempt. Resolves true on success, false on failure,
   *  cooldown or cancellation. */
  request(eventId: string, run: () => Promise<boolean>): Promise<boolean>;
  /** Drop a still-queued request (bubble unmounted). Running attempts finish. */
  cancel(eventId: string): void;
}

interface QueuedRequest {
  eventId: string;
  run: () => Promise<boolean>;
  resolve: (ok: boolean) => void;
  promise: Promise<boolean>;
}

const MAX_TRACKED_FAILURES = 500;

export function createDecryptRetryScheduler(opts: {
  concurrency: number;
  cooldownMs: number;
  now?: () => number;
}): DecryptRetryScheduler {
  const now = opts.now ?? (() => Date.now());
  const queue: QueuedRequest[] = [];
  const running = new Map<string, Promise<boolean>>();
  const lastFailureAt = new Map<string, number>();

  const recordFailure = (eventId: string): void => {
    lastFailureAt.delete(eventId);
    lastFailureAt.set(eventId, now());
    if (lastFailureAt.size > MAX_TRACKED_FAILURES) {
      const oldest = lastFailureAt.keys().next().value;
      if (oldest !== undefined) lastFailureAt.delete(oldest);
    }
  };

  const pump = (): void => {
    while (running.size < opts.concurrency && queue.length > 0) {
      const req = queue.pop()!;
      running.set(req.eventId, req.promise);
      void (async () => {
        let ok = false;
        try {
          ok = await req.run();
        } catch {
          ok = false;
        }
        if (ok) lastFailureAt.delete(req.eventId);
        else recordFailure(req.eventId);
        running.delete(req.eventId);
        req.resolve(ok);
        pump();
      })();
    }
  };

  return {
    request(eventId, run) {
      const inflight = running.get(eventId) ?? queue.find((q) => q.eventId === eventId)?.promise;
      if (inflight) return inflight;

      const failedAt = lastFailureAt.get(eventId);
      if (failedAt !== undefined && now() - failedAt < opts.cooldownMs) {
        return Promise.resolve(false);
      }

      let resolve!: (ok: boolean) => void;
      const promise = new Promise<boolean>((r) => { resolve = r; });
      queue.push({ eventId, run, resolve, promise });
      pump();
      return promise;
    },

    cancel(eventId) {
      const idx = queue.findIndex((q) => q.eventId === eventId);
      if (idx < 0) return;
      const [req] = queue.splice(idx, 1);
      req.resolve(false);
    },
  };
}

/** App-wide instance used by EncryptedMessageNotice. */
export const decryptRetryScheduler = createDecryptRetryScheduler({
  concurrency: 2,
  cooldownMs: 10_000,
});
