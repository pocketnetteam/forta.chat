import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { RpcBatcher } from "./rpc-batcher";

interface FakeItem {
  id: string;
  key: string;
  value: number;
}

describe("RpcBatcher", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  function createBatcher(
    executeFn: (keys: string[]) => Promise<FakeItem[]>,
    delayMs?: number,
  ) {
    return new RpcBatcher<string, FakeItem>({
      execute: executeFn,
      keyOf: (item) => item.key,
      delayMs,
    });
  }

  it("batches multiple load() calls within the delay window into a single execute()", async () => {
    const executeFn = vi.fn(async (keys: string[]) =>
      keys.map((k) => ({ id: `${k}-1`, key: k, value: 1 })),
    );

    const batcher = createBatcher(executeFn);

    const p1 = batcher.load("a");
    const p2 = batcher.load("b");
    const p3 = batcher.load("c");

    expect(executeFn).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(50);

    expect(executeFn).toHaveBeenCalledTimes(1);
    expect(executeFn).toHaveBeenCalledWith(["a", "b", "c"]);

    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
    expect(r1).toEqual([{ id: "a-1", key: "a", value: 1 }]);
    expect(r2).toEqual([{ id: "b-1", key: "b", value: 1 }]);
    expect(r3).toEqual([{ id: "c-1", key: "c", value: 1 }]);
  });

  it("routes multiple response items to the correct caller by key", async () => {
    const executeFn = vi.fn(async () => [
      { id: "1", key: "a", value: 10 },
      { id: "2", key: "a", value: 20 },
      { id: "3", key: "b", value: 30 },
    ]);

    const batcher = createBatcher(executeFn);

    const pa = batcher.load("a");
    const pb = batcher.load("b");

    await vi.advanceTimersByTimeAsync(50);

    expect(await pa).toEqual([
      { id: "1", key: "a", value: 10 },
      { id: "2", key: "a", value: 20 },
    ]);
    expect(await pb).toEqual([{ id: "3", key: "b", value: 30 }]);
  });

  it("resolves with [] for keys that have no matching response items", async () => {
    const executeFn = vi.fn(async () => [
      { id: "1", key: "a", value: 10 },
    ]);

    const batcher = createBatcher(executeFn);

    const pa = batcher.load("a");
    const pb = batcher.load("b");

    await vi.advanceTimersByTimeAsync(50);

    expect(await pa).toEqual([{ id: "1", key: "a", value: 10 }]);
    expect(await pb).toEqual([]);
  });

  it("duplicate key from two callers resolves both with the same data", async () => {
    const executeFn = vi.fn(async (keys: string[]) =>
      keys.map((k) => ({ id: `${k}-1`, key: k, value: 42 })),
    );

    const batcher = createBatcher(executeFn);

    const p1 = batcher.load("x");
    const p2 = batcher.load("x");

    await vi.advanceTimersByTimeAsync(50);

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toEqual([{ id: "x-1", key: "x", value: 42 }]);
    expect(r2).toEqual(r1);
    // Only unique keys are passed to execute
    expect(executeFn).toHaveBeenCalledWith(["x"]);
  });

  it("rejects all pending promises when execute() throws", async () => {
    const executeFn = vi.fn(async () => {
      throw new Error("RPC failure");
    });

    const batcher = createBatcher(executeFn);

    const p1 = batcher.load("a").catch((e) => e);
    const p2 = batcher.load("b").catch((e) => e);

    await vi.advanceTimersByTimeAsync(50);

    const [e1, e2] = await Promise.all([p1, p2]);
    expect(e1).toBeInstanceOf(Error);
    expect((e1 as Error).message).toBe("RPC failure");
    expect(e2).toBeInstanceOf(Error);
    expect((e2 as Error).message).toBe("RPC failure");
  });

  it("calls separated by more than delayMs produce separate batches", async () => {
    const executeFn = vi.fn(async (keys: string[]) =>
      keys.map((k) => ({ id: k, key: k, value: 1 })),
    );

    const batcher = createBatcher(executeFn, 30);

    const p1 = batcher.load("a");
    await vi.advanceTimersByTimeAsync(30);
    expect(executeFn).toHaveBeenCalledTimes(1);
    expect(executeFn).toHaveBeenCalledWith(["a"]);

    const p2 = batcher.load("b");
    await vi.advanceTimersByTimeAsync(30);
    expect(executeFn).toHaveBeenCalledTimes(2);
    expect(executeFn).toHaveBeenLastCalledWith(["b"]);

    expect(await p1).toEqual([{ id: "a", key: "a", value: 1 }]);
    expect(await p2).toEqual([{ id: "b", key: "b", value: 1 }]);
  });

  it("handles non-array execute() response gracefully", async () => {
    const executeFn = vi.fn(async () => null as any);

    const batcher = createBatcher(executeFn);
    const p = batcher.load("a");

    await vi.advanceTimersByTimeAsync(50);

    expect(await p).toEqual([]);
  });

  it("respects custom delayMs", async () => {
    const executeFn = vi.fn(async (keys: string[]) =>
      keys.map((k) => ({ id: k, key: k, value: 1 })),
    );

    const batcher = createBatcher(executeFn, 200);

    batcher.load("a");

    await vi.advanceTimersByTimeAsync(100);
    expect(executeFn).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(100);
    expect(executeFn).toHaveBeenCalledTimes(1);
  });
});
