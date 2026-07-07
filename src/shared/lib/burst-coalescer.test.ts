import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createBurstCoalescer } from "./burst-coalescer";

describe("createBurstCoalescer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("flushes once after the burst settles", () => {
    const flushes: number[][] = [];
    const c = createBurstCoalescer<number>((b) => flushes.push([...b]), {
      settleMs: 200,
      maxWaitMs: 2000,
    });

    c.push([1]);
    c.push([2]);
    c.push([3]);
    // Still within the settle window — nothing flushed yet.
    vi.advanceTimersByTime(199);
    expect(flushes).toEqual([]);

    vi.advanceTimersByTime(1);
    expect(flushes).toEqual([[1, 2, 3]]);
  });

  it("keeps coalescing while items arrive faster than settleMs", () => {
    const flushes: number[][] = [];
    const c = createBurstCoalescer<number>((b) => flushes.push([...b]), {
      settleMs: 220,
      maxWaitMs: 5000,
    });

    // Simulate a trickle: one item every 150ms (< settleMs) — a backlog stream.
    for (let i = 0; i < 10; i++) {
      c.push([i]);
      vi.advanceTimersByTime(150);
    }
    // Nothing flushed yet — the settle timer keeps resetting.
    expect(flushes).toEqual([]);

    // Stream stops → settle fires once with the whole burst.
    vi.advanceTimersByTime(220);
    expect(flushes).toHaveLength(1);
    expect(flushes[0]).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("respects maxWaitMs cap so a never-ending stream still flushes", () => {
    const flushes: number[][] = [];
    const c = createBurstCoalescer<number>((b) => flushes.push([...b]), {
      settleMs: 220,
      maxWaitMs: 600,
    });

    // Continuous trickle every 150ms; settle never fires, but maxWait caps it.
    for (let i = 0; i < 8; i++) {
      c.push([i]);
      vi.advanceTimersByTime(150);
    }
    // 8 * 150 = 1200ms elapsed → maxWait (600ms) fired at least once.
    expect(flushes.length).toBeGreaterThanOrEqual(1);
    // Everything pushed before the first maxWait flush is included.
    expect(flushes[0][0]).toBe(0);
  });

  it("flush() drains immediately", () => {
    const flushes: number[][] = [];
    const c = createBurstCoalescer<number>((b) => flushes.push([...b]), {
      settleMs: 200,
      maxWaitMs: 2000,
    });
    c.push([1, 2]);
    c.flush();
    expect(flushes).toEqual([[1, 2]]);
    // Timers were cleared — no double flush later.
    vi.advanceTimersByTime(2000);
    expect(flushes).toEqual([[1, 2]]);
  });

  it("cancel() drops pending items without flushing", () => {
    const flushes: number[][] = [];
    const c = createBurstCoalescer<number>((b) => flushes.push([...b]), {
      settleMs: 200,
      maxWaitMs: 2000,
    });
    c.push([1, 2]);
    c.cancel();
    vi.advanceTimersByTime(2000);
    expect(flushes).toEqual([]);
  });

  it("ignores empty pushes", () => {
    const flushes: number[][] = [];
    const c = createBurstCoalescer<number>((b) => flushes.push([...b]), {
      settleMs: 200,
      maxWaitMs: 2000,
    });
    c.push([]);
    vi.advanceTimersByTime(2000);
    expect(flushes).toEqual([]);
  });

  it("starts a fresh burst after a flush", () => {
    const flushes: number[][] = [];
    const c = createBurstCoalescer<number>((b) => flushes.push([...b]), {
      settleMs: 200,
      maxWaitMs: 2000,
    });
    c.push([1]);
    vi.advanceTimersByTime(200);
    expect(flushes).toEqual([[1]]);

    c.push([2]);
    vi.advanceTimersByTime(200);
    expect(flushes).toEqual([[1], [2]]);
  });
});
