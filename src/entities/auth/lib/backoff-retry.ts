/** A single pending retry with stepped backoff: each schedule() waits the next
 *  delay from the list (the last one repeats); cancel() drops a pending retry
 *  and resets the steps. Used for the own-profile load, which used to fail
 *  once at boot and never be retried. */
export interface BackoffRetry {
  /** Run `run` after the next delay. No-op while a retry is already pending. */
  schedule(run: () => void): void;
  /** Drop a pending retry and start the next schedule() from the first delay. */
  cancel(): void;
}

export function createBackoffRetry(delaysMs: readonly number[]): BackoffRetry {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;
  return {
    schedule(run) {
      if (timer || delaysMs.length === 0) return;
      const delay = delaysMs[Math.min(attempt, delaysMs.length - 1)];
      attempt++;
      timer = setTimeout(() => {
        timer = null;
        run();
      }, delay);
    },
    cancel() {
      if (timer) clearTimeout(timer);
      timer = null;
      attempt = 0;
    },
  };
}
