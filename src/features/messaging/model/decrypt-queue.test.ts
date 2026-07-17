import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { enqueueDecrypt } from "./decrypt-queue";

/**
 * Regression for WEE-90 H4.
 *
 * The decrypt queue is strictly serial (one decryptFile at a time to keep
 * low-end Android WebViews responsive). Before the fix, a task that never
 * settled — a hung worker, an upstream promise that never resolves — would
 * wedge the shared `tail` forever, so every later attachment queued behind it
 * and no media in the chat ever decrypted (eternal spinner). Each task is now
 * bounded by a hard timeout: a stuck task rejects and the chain advances.
 */
describe("enqueueDecrypt (WEE-90 H4)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves with the task result on success", async () => {
    await expect(enqueueDecrypt(() => Promise.resolve("ok"))).resolves.toBe("ok");
  });

  it("rejects a task that never settles, after the timeout", async () => {
    const p = enqueueDecrypt(() => new Promise<never>(() => { /* hang */ }));
    const assertion = expect(p).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(60_000);
    await assertion;
  });

  it("a stuck task does not block the next enqueued task", async () => {
    const stuck = enqueueDecrypt(() => new Promise<never>(() => { /* hang */ }));
    stuck.catch(() => { /* expected timeout — swallow */ });

    const nextRan = vi.fn();
    const next = enqueueDecrypt(() => {
      nextRan();
      return Promise.resolve("next");
    });

    // The next task must not run until the stuck task's deadline frees the
    // chain; before then it is parked behind the wedged tail.
    expect(nextRan).not.toHaveBeenCalled();

    // Advance past the stuck task's timeout so the chain unwedges.
    await vi.advanceTimersByTimeAsync(60_000);

    await expect(next).resolves.toBe("next");
    expect(nextRan).toHaveBeenCalledTimes(1);
  });
});
