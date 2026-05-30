import { describe, it, expect, vi } from "vitest";
import {
  connectMatrixWithRetry,
  type RetryableMatrixService,
} from "./connect-matrix-with-retry";

function createService(plan: Array<"ready" | "not-ready" | Error>): RetryableMatrixService {
  let step = 0;
  let ready = false;
  let error: string | false = false;

  return {
    init: async () => {
      const outcome = plan[Math.min(step, plan.length - 1)];
      step++;
      if (outcome instanceof Error) {
        error = outcome.message;
        ready = false;
        throw outcome;
      }
      if (outcome === "ready") {
        ready = true;
        error = false;
      } else {
        ready = false;
        error = "transient";
      }
    },
    isReady: () => ready,
    get error() {
      return error;
    },
  };
}

const instantSleep = () => Promise.resolve();

describe("connectMatrixWithRetry", () => {
  it("returns immediately when first attempt becomes ready", async () => {
    const service = createService(["ready"]);
    const result = await connectMatrixWithRetry(service, { sleep: instantSleep });

    expect(result.ready).toBe(true);
    expect(result.attempts).toBe(1);
    expect(result.lastError).toBeNull();
  });

  it("retries with exponential backoff after a throw, then succeeds", async () => {
    const sleep = vi.fn(instantSleep);
    const service = createService([new Error("ECONNREFUSED"), "ready"]);

    const onAttempt = vi.fn();
    const onAttemptFail = vi.fn();

    const result = await connectMatrixWithRetry(service, {
      sleep,
      onAttempt,
      onAttemptFail,
      baseDelayMs: 1_000,
      maxAttempts: 3,
    });

    expect(result.ready).toBe(true);
    expect(result.attempts).toBe(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(1_000);
    expect(onAttempt).toHaveBeenCalledTimes(2);
    expect(onAttemptFail).toHaveBeenCalledTimes(1);
  });

  it("treats init() resolving with isReady=false as a transient failure and retries", async () => {
    const sleep = vi.fn(instantSleep);
    const service = createService(["not-ready", "not-ready", "ready"]);

    const result = await connectMatrixWithRetry(service, {
      sleep,
      baseDelayMs: 1_000,
      maxAttempts: 3,
    });

    expect(result.ready).toBe(true);
    expect(result.attempts).toBe(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenNthCalledWith(1, 1_000);
    expect(sleep).toHaveBeenNthCalledWith(2, 2_000);
  });

  it("caps backoff delay at maxDelayMs", async () => {
    const sleep = vi.fn(instantSleep);
    const service = createService(["not-ready", "not-ready", "not-ready", "ready"]);

    await connectMatrixWithRetry(service, {
      sleep,
      baseDelayMs: 10_000,
      maxDelayMs: 12_000,
      maxAttempts: 4,
    });

    expect(sleep).toHaveBeenNthCalledWith(1, 10_000);
    expect(sleep).toHaveBeenNthCalledWith(2, 12_000);
    expect(sleep).toHaveBeenNthCalledWith(3, 12_000);
  });

  it("returns ready=false after exhausting attempts and surfaces lastError", async () => {
    const sleep = vi.fn(instantSleep);
    const failure = new Error("homeserver 503");
    const service = createService([failure, failure, failure]);

    const result = await connectMatrixWithRetry(service, {
      sleep,
      baseDelayMs: 1_000,
      maxAttempts: 3,
    });

    expect(result.ready).toBe(false);
    expect(result.attempts).toBe(3);
    expect(result.lastError).toBe(failure);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("times out a stuck init() and retries the next attempt", async () => {
    const sleep = vi.fn(instantSleep);
    let attempts = 0;
    const service: RetryableMatrixService = {
      init: () => {
        attempts++;
        if (attempts < 2) {
          // Never settles — withTimeout must reject.
          return new Promise<void>(() => {});
        }
        return Promise.resolve();
      },
      isReady: () => attempts >= 2,
      error: false,
    };

    const result = await connectMatrixWithRetry(service, {
      sleep,
      attemptTimeoutMs: 5,
      baseDelayMs: 1,
      maxAttempts: 3,
    });

    expect(result.ready).toBe(true);
    expect(result.attempts).toBe(2);
  });

  it("never sleeps after the final attempt", async () => {
    const sleep = vi.fn(instantSleep);
    const service = createService(["not-ready"]);

    await connectMatrixWithRetry(service, {
      sleep,
      baseDelayMs: 1_000,
      maxAttempts: 1,
    });

    expect(sleep).not.toHaveBeenCalled();
  });

  it("synthesises a diagnostic error when init() resolves but isReady() stays false", async () => {
    const onAttemptFail = vi.fn();
    const service: RetryableMatrixService = {
      init: async () => {},
      isReady: () => false,
      error: false,
    };

    const result = await connectMatrixWithRetry(service, {
      sleep: instantSleep,
      onAttemptFail,
      maxAttempts: 1,
    });

    expect(result.ready).toBe(false);
    expect(onAttemptFail).toHaveBeenCalledTimes(1);
    const passedError = onAttemptFail.mock.calls[0][1];
    expect(passedError).toBeInstanceOf(Error);
    expect((passedError as Error).message).toMatch(/not ready/i);
  });

  it("propagates service.error string into the synthesised not-ready failure", async () => {
    const onAttemptFail = vi.fn();
    const service: RetryableMatrixService = {
      init: async () => {},
      isReady: () => false,
      error: "homeserver returned 503",
    };

    await connectMatrixWithRetry(service, {
      sleep: instantSleep,
      onAttemptFail,
      maxAttempts: 1,
    });

    const passedError = onAttemptFail.mock.calls[0][1];
    expect((passedError as Error).message).toBe("homeserver returned 503");
  });
});
