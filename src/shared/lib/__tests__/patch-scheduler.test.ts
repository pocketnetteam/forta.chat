import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createPatchScheduler } from "../patch-scheduler";

describe("createPatchScheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("coalesces multiple schedule() calls in the same tick into one flush", async () => {
    const flushes: string[][] = [];
    const s = createPatchScheduler<string>((b) => flushes.push([...b]), { useRaf: false });

    s.schedule(["a"]);
    s.schedule(["b"]);
    s.schedule(["c", "d"]);

    expect(flushes).toHaveLength(0); // deferred

    await vi.runAllTimersAsync();
    // Also drain microtasks explicitly — fake timers don't advance microtask queue
    await Promise.resolve();
    await Promise.resolve();

    expect(flushes).toHaveLength(1);
    expect(flushes[0]).toEqual(["a", "b", "c", "d"]);
  });

  it("cancel() drops pending items without flushing", async () => {
    const flushes: string[][] = [];
    const s = createPatchScheduler<string>((b) => flushes.push([...b]), { useRaf: false });

    s.schedule(["a", "b"]);
    s.cancel();
    await Promise.resolve();
    await Promise.resolve();

    expect(flushes).toHaveLength(0);
  });

  it("schedule() after cancel() schedules a fresh flush", async () => {
    const flushes: string[][] = [];
    const s = createPatchScheduler<string>((b) => flushes.push([...b]), { useRaf: false });

    s.schedule(["a"]);
    s.cancel();
    s.schedule(["b"]);
    await Promise.resolve();
    await Promise.resolve();

    expect(flushes).toHaveLength(1);
    expect(flushes[0]).toEqual(["b"]);
  });

  it("empty schedule() is a no-op", async () => {
    const flushes: string[][] = [];
    const s = createPatchScheduler<string>((b) => flushes.push([...b]), { useRaf: false });

    s.schedule([]);
    await Promise.resolve();
    await Promise.resolve();

    expect(flushes).toHaveLength(0);
  });

  it("uses requestAnimationFrame when available", async () => {
    const rafCalls: FrameRequestCallback[] = [];
    const raf = vi.fn((cb: FrameRequestCallback): number => {
      rafCalls.push(cb);
      return rafCalls.length;
    });
    vi.stubGlobal("requestAnimationFrame", raf);
    vi.stubGlobal("cancelAnimationFrame", vi.fn());

    try {
      const flushes: string[][] = [];
      const s = createPatchScheduler<string>((b) => flushes.push([...b]));

      s.schedule(["a"]);
      s.schedule(["b"]);

      expect(raf).toHaveBeenCalledTimes(1); // one rAF for the whole batch
      expect(flushes).toHaveLength(0);

      // Simulate frame
      rafCalls[0](performance.now());

      expect(flushes).toHaveLength(1);
      expect(flushes[0]).toEqual(["a", "b"]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("cancel() calls cancelAnimationFrame for a pending rAF", async () => {
    const cancel = vi.fn();
    vi.stubGlobal("requestAnimationFrame", vi.fn(() => 42));
    vi.stubGlobal("cancelAnimationFrame", cancel);

    try {
      const s = createPatchScheduler<string>(() => {});
      s.schedule(["a"]);
      s.cancel();
      expect(cancel).toHaveBeenCalledWith(42);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("a subsequent flush cycle works after the first one completes", async () => {
    const flushes: string[][] = [];
    const s = createPatchScheduler<string>((b) => flushes.push([...b]), { useRaf: false });

    s.schedule(["a"]);
    await Promise.resolve();
    await Promise.resolve();
    expect(flushes).toHaveLength(1);

    s.schedule(["b"]);
    await Promise.resolve();
    await Promise.resolve();

    expect(flushes).toHaveLength(2);
    expect(flushes[1]).toEqual(["b"]);
  });
});
