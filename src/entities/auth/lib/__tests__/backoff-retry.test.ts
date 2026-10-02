import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createBackoffRetry } from "../backoff-retry";

describe("createBackoffRetry", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("steps through the delays and repeats the last one", async () => {
    const retry = createBackoffRetry([1_000, 5_000]);
    const run = vi.fn();

    retry.schedule(run);
    await vi.advanceTimersByTimeAsync(999);
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(1);

    retry.schedule(run);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(run).toHaveBeenCalledTimes(2);

    retry.schedule(run);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(run).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(3);
  });

  it("keeps a single pending retry", async () => {
    const retry = createBackoffRetry([1_000]);
    const run = vi.fn();
    retry.schedule(run);
    retry.schedule(run);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("cancel drops the pending retry and restarts from the first delay", async () => {
    const retry = createBackoffRetry([1_000, 5_000]);
    const run = vi.fn();
    retry.schedule(run);
    await vi.advanceTimersByTimeAsync(1_000);
    retry.schedule(run);
    retry.cancel();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(run).toHaveBeenCalledTimes(1);

    retry.schedule(run);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(run).toHaveBeenCalledTimes(2);
  });
});
