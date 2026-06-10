import { describe, test, expect } from "vitest";
import { runInBatches } from "./run-in-batches";

describe("runInBatches", () => {
  test("preserves input order in results", async () => {
    const items = [1, 2, 3, 4, 5, 6, 7];
    const results = await runInBatches(items, 3, async (n) => n * 10);
    expect(results).toEqual([10, 20, 30, 40, 50, 60, 70]);
  });

  test("runs items within a batch concurrently, batches sequentially", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const items = Array.from({ length: 10 }, (_, i) => i);

    await runInBatches(items, 5, async (n) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return n;
    });

    // Parallel inside a batch (regression for WEE-96: previews were strictly
    // sequential), but never more than one batch at a time.
    expect(maxInFlight).toBe(5);
  });

  test("calls betweenBatches between batches but not after the last one", async () => {
    let yields = 0;
    await runInBatches([1, 2, 3, 4, 5], 2, async (n) => n, async () => {
      yields++;
    });
    // 3 batches → 2 yields
    expect(yields).toBe(2);
  });

  test("handles empty input", async () => {
    const results = await runInBatches([], 5, async (n) => n);
    expect(results).toEqual([]);
  });

  test("rejects when size < 1", async () => {
    await expect(runInBatches([1], 0, async (n) => n)).rejects.toThrow("size must be >= 1");
  });

  test("propagates mapper rejection (Promise.all semantics)", async () => {
    await expect(
      runInBatches([1, 2], 2, async (n) => {
        if (n === 2) throw new Error("boom");
        return n;
      }),
    ).rejects.toThrow("boom");
  });
});
