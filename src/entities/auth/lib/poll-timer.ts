/** Elapsed-time tracker that excludes time spent paused (e.g. app backgrounded).
 *
 *  Why: Android (Capacitor WebView) throttles setTimeout when the app is in the
 *  background. Users swiped the app away for 12 hours, came back, and the
 *  30-min REGISTRATION_POLL_TIMEOUT fired immediately because
 *  `Date.now() - pollStartedAt` ignores whether the timer was even running.
 *
 *  Contract:
 *  - `elapsed()` returns monotonic active time in ms since construction
 *    (or last `resetStart()`), minus any paused intervals.
 *  - `pause()` freezes elapsed; a second `pause()` is a no-op.
 *  - `resume()` unfreezes; a call without a prior `pause()` is a no-op.
 *  - `resetStart()` clears the baseline — used on retry so the timeout
 *    budget starts fresh.
 *  - `isExpired(maxMs)` is a convenience.
 */
export class PollTimer {
  private startedAt: number;
  private accumulatedPause = 0;
  private pausedAt: number | null = null;

  constructor(now: number = Date.now()) {
    this.startedAt = now;
  }

  resetStart(now: number = Date.now()): void {
    this.startedAt = now;
    this.accumulatedPause = 0;
    this.pausedAt = null;
  }

  pause(now: number = Date.now()): void {
    if (this.pausedAt !== null) return; // idempotent
    this.pausedAt = now;
  }

  resume(now: number = Date.now()): void {
    if (this.pausedAt === null) return;
    this.accumulatedPause += now - this.pausedAt;
    this.pausedAt = null;
  }

  elapsed(now: number = Date.now()): number {
    // While paused, clamp "now" to when pause started
    const effectiveNow = this.pausedAt !== null ? this.pausedAt : now;
    return effectiveNow - this.startedAt - this.accumulatedPause;
  }

  isExpired(maxMs: number, now: number = Date.now()): boolean {
    return this.elapsed(now) > maxMs;
  }
}
