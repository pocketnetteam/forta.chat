interface Window {
  start: number;
  count: number;
}

/** Keys kept before stale windows are dropped. */
const PRUNE_AT = 10_000;

/**
 * Fixed-window counter per key, in memory. Each Worker isolate or Node process
 * counts on its own, so this is a floor; the host's rate-limit rules are the
 * real protection.
 */
export class FixedWindowLimiter {
  private readonly windows = new Map<string, Window>();
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(limit: number, windowMs: number, now: () => number) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.now = now;
  }

  /** Counts one request; false when the key has used up its window. */
  take(key: string): boolean {
    const t = this.now();
    if (this.windows.size >= PRUNE_AT) this.prune(t);
    const window = this.windows.get(key);
    if (!window || t - window.start >= this.windowMs) {
      this.windows.set(key, { start: t, count: 1 });
      return true;
    }
    if (window.count >= this.limit) return false;
    window.count++;
    return true;
  }

  /** Seconds until the window of [key] ends. */
  retryAfterSeconds(key: string): number {
    const window = this.windows.get(key);
    if (!window) return 0;
    return Math.max(1, Math.ceil((window.start + this.windowMs - this.now()) / 1000));
  }

  private prune(t: number): void {
    for (const [key, window] of this.windows) {
      if (t - window.start >= this.windowMs) this.windows.delete(key);
    }
    // Every window still open: memory wins over the per-key count. The global
    // limiter in the handler still caps the total.
    if (this.windows.size >= PRUNE_AT) this.windows.clear();
  }
}
