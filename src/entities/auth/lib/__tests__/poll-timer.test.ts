import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PollTimer } from "../poll-timer";

describe("PollTimer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("tracks elapsed time since construction", () => {
    const timer = new PollTimer();
    vi.advanceTimersByTime(10_000);
    expect(timer.elapsed()).toBe(10_000);
  });

  it("resetStart() resets the elapsed baseline", () => {
    const timer = new PollTimer();
    vi.advanceTimersByTime(30_000);
    timer.resetStart();
    expect(timer.elapsed()).toBe(0);
    vi.advanceTimersByTime(5_000);
    expect(timer.elapsed()).toBe(5_000);
  });

  it("isExpired(max) reports true once elapsed exceeds limit", () => {
    const timer = new PollTimer();
    vi.advanceTimersByTime(29_000);
    expect(timer.isExpired(30_000)).toBe(false);
    vi.advanceTimersByTime(1_500);
    expect(timer.isExpired(30_000)).toBe(true);
  });

  it("pause() + resume() do NOT count time spent in background towards elapsed", () => {
    const timer = new PollTimer();
    vi.advanceTimersByTime(5_000); // 5s active

    timer.pause();
    vi.advanceTimersByTime(60 * 60 * 1000); // 1h in background
    timer.resume();

    // only 5s of active time should have elapsed
    expect(timer.elapsed()).toBe(5_000);

    vi.advanceTimersByTime(2_000);
    expect(timer.elapsed()).toBe(7_000);
  });

  it("multiple pause/resume cycles accumulate correctly", () => {
    const timer = new PollTimer();
    vi.advanceTimersByTime(1_000);

    timer.pause();
    vi.advanceTimersByTime(10_000);
    timer.resume();

    vi.advanceTimersByTime(2_000);

    timer.pause();
    vi.advanceTimersByTime(5_000);
    timer.resume();

    vi.advanceTimersByTime(3_000);

    expect(timer.elapsed()).toBe(6_000);
  });

  it("resume() without pause() is a no-op", () => {
    const timer = new PollTimer();
    vi.advanceTimersByTime(5_000);
    timer.resume();
    expect(timer.elapsed()).toBe(5_000);
  });

  it("pause() is idempotent (double-pause does not skew time)", () => {
    const timer = new PollTimer();
    vi.advanceTimersByTime(1_000);
    timer.pause();
    vi.advanceTimersByTime(5_000);
    timer.pause(); // second pause ignored
    vi.advanceTimersByTime(5_000);
    timer.resume();
    vi.advanceTimersByTime(2_000);
    expect(timer.elapsed()).toBe(3_000);
  });

  it("isExpired correctly accounts for background time", () => {
    const timer = new PollTimer();
    vi.advanceTimersByTime(10_000);
    timer.pause();
    vi.advanceTimersByTime(60 * 60 * 1000); // 1h background
    timer.resume();
    // still only 10s of active time, 30-min timeout NOT reached
    expect(timer.isExpired(30 * 60 * 1000)).toBe(false);
  });
});
