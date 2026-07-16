import { describe, it, expect, vi } from "vitest";
import { withRetry } from "../with-retry";

describe("withRetry", () => {
  it("returns on first success without delay", async () => {
    const op = vi.fn().mockResolvedValueOnce("ok");

    const result = await withRetry(op, { delaysMs: [50, 150], label: "test" });

    expect(result).toEqual({ outcome: "success", value: "ok", attempts: 1 });
    expect(op).toHaveBeenCalledTimes(1);
  });

  it("retries on transient failure and resolves on second attempt", async () => {
    const op = vi
      .fn()
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValueOnce("ok");
    const sleep = vi.fn().mockResolvedValue(undefined);

    const result = await withRetry(op, {
      delaysMs: [50, 150],
      label: "test",
      sleep,
    });

    expect(result.outcome).toBe("success");
    if (result.outcome === "success") {
      expect(result.value).toBe("ok");
      expect(result.attempts).toBe(2);
    }
    expect(op).toHaveBeenCalledTimes(2);
    // Sleep called once between attempt 1 and attempt 2, with the FIRST delay.
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(50);
  });

  it("walks the delays array in order across multiple retries", async () => {
    const op = vi
      .fn()
      .mockRejectedValueOnce(new Error("e1"))
      .mockRejectedValueOnce(new Error("e2"))
      .mockResolvedValueOnce("ok");
    const sleep = vi.fn().mockResolvedValue(undefined);

    const result = await withRetry(op, {
      delaysMs: [50, 150, 400],
      label: "test",
      sleep,
    });

    expect(result.outcome).toBe("success");
    expect(op).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([50, 150]);
  });

  it("gives up after exhausting all attempts and reports the last error", async () => {
    const finalError = new Error("final");
    const op = vi
      .fn()
      .mockRejectedValueOnce(new Error("e1"))
      .mockRejectedValueOnce(new Error("e2"))
      .mockRejectedValue(finalError);
    const sleep = vi.fn().mockResolvedValue(undefined);

    const result = await withRetry(op, {
      delaysMs: [10, 20],
      label: "test",
      sleep,
    });

    // delaysMs.length=2 → total attempts = 3 (initial + 2 retries).
    expect(result).toEqual({
      outcome: "failure",
      error: finalError,
      attempts: 3,
    });
    expect(op).toHaveBeenCalledTimes(3);
    // Two sleeps between the three attempts.
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("does not retry when delaysMs is empty (single-shot)", async () => {
    const err = new Error("nope");
    const op = vi.fn().mockRejectedValue(err);
    const sleep = vi.fn().mockResolvedValue(undefined);

    const result = await withRetry(op, {
      delaysMs: [],
      label: "test",
      sleep,
    });

    expect(result).toEqual({ outcome: "failure", error: err, attempts: 1 });
    expect(op).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("captures non-Error rejections without crashing", async () => {
    const op = vi.fn().mockRejectedValue("string error");
    const sleep = vi.fn().mockResolvedValue(undefined);

    const result = await withRetry(op, {
      delaysMs: [5],
      label: "test",
      sleep,
      onAttemptFailed: () => {
        /* quiet stderr in test */
      },
    });

    expect(result.outcome).toBe("failure");
    if (result.outcome === "failure") {
      // Non-Error rejections are wrapped so the consumer always gets a real Error.
      expect(result.error).toBeInstanceOf(Error);
      expect(result.error.message).toContain("string error");
    }
  });

  it("wraps undefined and null rejections in informative Errors", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);

    const undefRes = await withRetry(
      () => Promise.reject(undefined),
      {
        delaysMs: [],
        label: "test",
        sleep,
        onAttemptFailed: () => {
          /* quiet stderr */
        },
      },
    );
    expect(undefRes.outcome).toBe("failure");
    if (undefRes.outcome === "failure") {
      expect(undefRes.error.message).toMatch(/undefined/);
    }

    const nullRes = await withRetry(
      () => Promise.reject(null),
      {
        delaysMs: [],
        label: "test",
        sleep,
        onAttemptFailed: () => {
          /* quiet stderr */
        },
      },
    );
    expect(nullRes.outcome).toBe("failure");
    if (nullRes.outcome === "failure") {
      expect(nullRes.error.message).toMatch(/null/);
    }
  });

  it("aborts before retrying when signal is already aborted in backoff", async () => {
    const controller = new AbortController();
    const op = vi
      .fn()
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValueOnce("ok");
    const sleep = vi.fn().mockImplementation(async () => {
      // Simulate a hangup happening DURING the backoff sleep.
      controller.abort();
    });

    const result = await withRetry(op, {
      delaysMs: [50, 150],
      label: "test",
      sleep,
      signal: controller.signal,
      onAttemptFailed: () => {
        /* quiet stderr */
      },
    });

    // After the first failure we sleep, signal aborts during sleep, the
    // loop must NOT call op() again.
    expect(result.outcome).toBe("aborted");
    if (result.outcome === "aborted") {
      expect(result.attempts).toBe(1);
    }
    expect(op).toHaveBeenCalledTimes(1);
  });

  it("aborts before the first attempt when signal is pre-aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const op = vi.fn();

    const result = await withRetry(op, {
      delaysMs: [50],
      label: "test",
      signal: controller.signal,
    });

    expect(result).toEqual({ outcome: "aborted", attempts: 0 });
    expect(op).not.toHaveBeenCalled();
  });

  it("calls the injected onAttemptFailed hook with structured payload", async () => {
    const onAttemptFailed = vi.fn();
    const err = new Error("nope");
    const op = vi.fn().mockRejectedValue(err);
    const sleep = vi.fn().mockResolvedValue(undefined);

    await withRetry(op, {
      delaysMs: [50, 150],
      label: "structured",
      sleep,
      onAttemptFailed,
    });

    expect(onAttemptFailed).toHaveBeenCalledTimes(3);
    expect(onAttemptFailed.mock.calls[0][0]).toMatchObject({
      attempt: 1,
      error: err,
      nextDelayMs: 50,
      label: "structured",
    });
    expect(onAttemptFailed.mock.calls[2][0]).toMatchObject({
      attempt: 3,
      nextDelayMs: null,
    });
  });
});
