import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  signalChatsInteractive,
  isChatsInteractive,
  whenChatsInteractive,
  __resetBootSignalsForTests,
} from "./boot-signals";

describe("boot-signals (WEE-97)", () => {
  beforeEach(() => {
    __resetBootSignalsForTests();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts not-interactive", () => {
    expect(isChatsInteractive()).toBe(false);
  });

  it("whenChatsInteractive resolves when the signal fires", async () => {
    const resolved = vi.fn();
    whenChatsInteractive(60_000).then(resolved);

    await vi.advanceTimersByTimeAsync(0);
    expect(resolved).not.toHaveBeenCalled();

    signalChatsInteractive();
    await vi.advanceTimersByTimeAsync(0);

    expect(resolved).toHaveBeenCalledTimes(1);
    expect(isChatsInteractive()).toBe(true);
  });

  it("resolves immediately when already signaled", async () => {
    signalChatsInteractive();
    const resolved = vi.fn();
    whenChatsInteractive(60_000).then(resolved);
    await vi.advanceTimersByTimeAsync(0);
    expect(resolved).toHaveBeenCalledTimes(1);
  });

  it("falls back to the timeout when the signal never fires", async () => {
    const resolved = vi.fn();
    whenChatsInteractive(5_000).then(resolved);

    await vi.advanceTimersByTimeAsync(4_999);
    expect(resolved).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(resolved).toHaveBeenCalledTimes(1);
    // Fallback path does not mark chats as interactive
    expect(isChatsInteractive()).toBe(false);
  });

  it("signal is idempotent", async () => {
    signalChatsInteractive();
    signalChatsInteractive();
    const resolved = vi.fn();
    whenChatsInteractive(60_000).then(resolved);
    await vi.advanceTimersByTimeAsync(0);
    expect(resolved).toHaveBeenCalledTimes(1);
  });
});
