import { describe, it, expect, vi } from "vitest";
import { createDecryptRetryScheduler } from "./decrypt-retry-scheduler";

function deferred() {
  let resolve!: (ok: boolean) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<boolean>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("createDecryptRetryScheduler", () => {
  it("never runs more than `concurrency` attempts at once", async () => {
    const s = createDecryptRetryScheduler({ concurrency: 2, cooldownMs: 0 });
    const gates = Array.from({ length: 5 }, () => deferred());
    let active = 0;
    let peak = 0;
    const results = gates.map((g, i) =>
      s.request(`$e${i}`, async () => {
        active++;
        peak = Math.max(peak, active);
        const ok = await g.promise;
        active--;
        return ok;
      }),
    );

    await flush();
    expect(active).toBe(2);
    for (const g of gates) { g.resolve(true); await flush(); }
    expect(await Promise.all(results)).toEqual([true, true, true, true, true]);
    expect(peak).toBe(2);
  });

  it("serves the most recent request first (LIFO) once a slot frees up", async () => {
    const s = createDecryptRetryScheduler({ concurrency: 1, cooldownMs: 0 });
    const order: string[] = [];
    const first = deferred();
    void s.request("$first", async () => { order.push("$first"); return first.promise; });
    void s.request("$old", async () => { order.push("$old"); return true; });
    const last = s.request("$new", async () => { order.push("$new"); return true; });

    first.resolve(true);
    await last;
    await flush();
    expect(order).toEqual(["$first", "$new", "$old"]);
  });

  it("deduplicates requests for the same eventId", async () => {
    const s = createDecryptRetryScheduler({ concurrency: 2, cooldownMs: 0 });
    const run = vi.fn(async () => true);
    const a = s.request("$e1", run);
    const b = s.request("$e1", run);
    expect(await a).toBe(true);
    expect(await b).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("suppresses retries during the cooldown after a failure, then allows them again", async () => {
    let t = 1_000;
    const s = createDecryptRetryScheduler({ concurrency: 1, cooldownMs: 10_000, now: () => t });
    const run = vi.fn(async () => false);

    expect(await s.request("$e1", run)).toBe(false);
    expect(await s.request("$e1", run)).toBe(false);
    expect(run).toHaveBeenCalledTimes(1);

    t += 10_000;
    expect(await s.request("$e1", run)).toBe(false);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("treats a thrown attempt as a failure and keeps pumping the queue", async () => {
    const s = createDecryptRetryScheduler({ concurrency: 1, cooldownMs: 0 });
    const boom = s.request("$bad", async () => { throw new Error("no keys"); });
    const next = s.request("$good", async () => true);
    expect(await boom).toBe(false);
    expect(await next).toBe(true);
  });

  it("cancel() drops a queued request without running it", async () => {
    const s = createDecryptRetryScheduler({ concurrency: 1, cooldownMs: 0 });
    const gate = deferred();
    void s.request("$busy", () => gate.promise);
    const run = vi.fn(async () => true);
    const queued = s.request("$gone", run);

    s.cancel("$gone");
    expect(await queued).toBe(false);
    gate.resolve(true);
    await flush();
    expect(run).not.toHaveBeenCalled();
  });
});
