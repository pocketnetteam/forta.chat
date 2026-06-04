import { describe, it, expect } from "vitest";
import { createSemaphore } from "./semaphore";

/** Drain the microtask queue so queued `acquire()` resolutions settle. */
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe("createSemaphore", () => {
  it("rejects a non-positive or non-integer max", () => {
    expect(() => createSemaphore(0)).toThrow();
    expect(() => createSemaphore(-1)).toThrow();
    expect(() => createSemaphore(1.5)).toThrow();
  });

  it("resolves immediately while slots are free", async () => {
    const sem = createSemaphore(2);
    await sem.acquire();
    await sem.acquire();
    expect(sem.active).toBe(2);
    expect(sem.pending).toBe(0);
  });

  it("queues acquisitions beyond the limit and resolves them on release", async () => {
    const sem = createSemaphore(2);
    await sem.acquire();
    await sem.acquire();

    let thirdResolved = false;
    const third = sem.acquire().then(() => {
      thirdResolved = true;
    });

    await flush();
    expect(thirdResolved).toBe(false);
    expect(sem.pending).toBe(1);
    expect(sem.active).toBe(2);

    sem.release();
    await third;
    expect(thirdResolved).toBe(true);
    expect(sem.active).toBe(2); // slot handed off, still full
    expect(sem.pending).toBe(0);
  });

  it("never lets more than `max` operations run concurrently", async () => {
    const LIMIT = 3;
    const TASKS = 12;
    const sem = createSemaphore(LIMIT);
    let inFlight = 0;
    let peak = 0;

    const run = async (): Promise<void> => {
      await sem.acquire();
      inFlight++;
      peak = Math.max(peak, inFlight);
      try {
        await flush(); // simulate async work
      } finally {
        inFlight--;
        sem.release();
      }
    };

    await Promise.all(Array.from({ length: TASKS }, run));

    expect(peak).toBeLessThanOrEqual(LIMIT);
    expect(sem.active).toBe(0);
    expect(sem.pending).toBe(0);
  });

  it("preserves FIFO order for queued waiters", async () => {
    const sem = createSemaphore(1);
    await sem.acquire();

    const order: number[] = [];
    const w1 = sem.acquire().then(() => order.push(1));
    const w2 = sem.acquire().then(() => order.push(2));
    const w3 = sem.acquire().then(() => order.push(3));

    sem.release();
    await w1;
    sem.release();
    await w2;
    sem.release();
    await w3;

    expect(order).toEqual([1, 2, 3]);
  });

  it("ignores a stray release() when nothing is held", () => {
    const sem = createSemaphore(2);
    sem.release();
    sem.release();
    expect(sem.active).toBe(0);
  });
});
