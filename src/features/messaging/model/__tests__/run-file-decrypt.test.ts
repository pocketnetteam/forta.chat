import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * WEE-92 — runFileDecrypt concurrency policy.
 *
 * Worker available → decrypt tasks run in PARALLEL (the work is off the main
 * thread; mediaDownloadGate caps effective concurrency at the call site).
 * Worker unavailable → legacy strictly-serial main-thread queue, the
 * #306/#370 freeze guard.
 */

const isCryptoWorkerSupported = vi.fn<() => boolean>();

vi.mock("@/shared/lib/crypto-worker/bridge", () => ({
  isCryptoWorkerSupported: () => isCryptoWorkerSupported(),
}));

import { runFileDecrypt } from "../decrypt-queue";

/** A task that records when it starts and settles only when told to. */
function controlledTask(startLog: string[], name: string) {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const task = async () => {
    startLog.push(name);
    await gate;
    return name;
  };
  return { task, release };
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

beforeEach(() => {
  isCryptoWorkerSupported.mockReset();
});

describe("runFileDecrypt (WEE-92)", () => {
  it("runs tasks in parallel when the crypto worker is available", async () => {
    isCryptoWorkerSupported.mockReturnValue(true);
    const started: string[] = [];
    const a = controlledTask(started, "a");
    const b = controlledTask(started, "b");

    const pa = runFileDecrypt(a.task);
    const pb = runFileDecrypt(b.task);
    await tick();

    // Both started before either finished — no serialisation.
    expect(started).toEqual(["a", "b"]);

    a.release(); b.release();
    await expect(pa).resolves.toBe("a");
    await expect(pb).resolves.toBe("b");
  });

  it("serialises tasks through the legacy queue when the worker is unavailable", async () => {
    isCryptoWorkerSupported.mockReturnValue(false);
    const started: string[] = [];
    const a = controlledTask(started, "a");
    const b = controlledTask(started, "b");

    const pa = runFileDecrypt(a.task);
    const pb = runFileDecrypt(b.task);
    await tick();

    // Only the first task started; the second waits in the queue.
    expect(started).toEqual(["a"]);

    a.release();
    await pa;
    await tick();
    expect(started).toEqual(["a", "b"]);

    b.release();
    await expect(pb).resolves.toBe("b");
  });

  it("serialises LARGE files through the queue even with the worker (memory guard)", async () => {
    isCryptoWorkerSupported.mockReturnValue(true);
    const started: string[] = [];
    const a = controlledTask(started, "big-a");
    const b = controlledTask(started, "big-b");
    const BIG = 64 * 1024 * 1024;

    const pa = runFileDecrypt(a.task, { sizeBytes: BIG });
    const pb = runFileDecrypt(b.task, { sizeBytes: BIG });
    await tick();

    // Three concurrent ~100MB video buffers would OOM low-end devices —
    // large files keep the strictly-serial path.
    expect(started).toEqual(["big-a"]);

    a.release();
    await pa;
    await tick();
    expect(started).toEqual(["big-a", "big-b"]);
    b.release();
    await pb;
  });

  it("propagates task rejections in the parallel path", async () => {
    isCryptoWorkerSupported.mockReturnValue(true);
    await expect(
      runFileDecrypt(() => Promise.reject(new Error("OperationError"))),
    ).rejects.toThrow("OperationError");
  });

  it("bounds a hung parallel task with the decrypt timeout", async () => {
    isCryptoWorkerSupported.mockReturnValue(true);
    vi.useFakeTimers();
    try {
      const p = runFileDecrypt(() => new Promise<never>(() => { /* hang */ }));
      const assertion = expect(p).rejects.toThrow(/timed out/);
      await vi.advanceTimersByTimeAsync(60_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});
