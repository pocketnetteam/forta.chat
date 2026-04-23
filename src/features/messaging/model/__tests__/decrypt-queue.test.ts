/**
 * Sequential decrypt queue — serialises expensive file decryption across
 * concurrent download calls. On old Android WebViews (Android 7/8 Xiaomi)
 * running decryptFile on 10 inbound images at once saturates the CPU and
 * the main thread freezes for tens of seconds. Running them one-at-a-time
 * keeps the UI responsive.
 *
 * Mirrors bastyon-chat's `decryptFileQueue` / `f.processArray` pattern
 * (pcrypto.js:1256-1273).
 */
import { describe, it, expect } from "vitest";
import { enqueueDecrypt } from "../decrypt-queue";

describe("enqueueDecrypt — sequential execution", () => {
  it("runs tasks one at a time even when scheduled concurrently", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const makeTask = (ms: number, tag: string) => async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, ms));
      inFlight--;
      return tag;
    };

    const p1 = enqueueDecrypt(makeTask(20, "a"));
    const p2 = enqueueDecrypt(makeTask(20, "b"));
    const p3 = enqueueDecrypt(makeTask(20, "c"));

    const results = await Promise.all([p1, p2, p3]);
    expect(results).toEqual(["a", "b", "c"]);
    // Parallel execution would yield maxInFlight >= 2; sequential caps at 1.
    expect(maxInFlight).toBe(1);
  });

  it("preserves enqueue order under rapid scheduling", async () => {
    const order: number[] = [];
    const tasks = Array.from({ length: 5 }, (_, i) => async () => {
      // Slight per-task delay so out-of-order resolution would surface.
      await new Promise((r) => setTimeout(r, 5));
      order.push(i);
      return i;
    });
    const results = await Promise.all(tasks.map((t) => enqueueDecrypt(t)));
    expect(results).toEqual([0, 1, 2, 3, 4]);
    expect(order).toEqual([0, 1, 2, 3, 4]);
  });

  it("survives a failing task without poisoning the queue", async () => {
    const p1 = enqueueDecrypt<string>(async () => {
      throw new Error("boom");
    });
    await expect(p1).rejects.toThrow("boom");

    // Follow-up task must still execute.
    const p2 = enqueueDecrypt<string>(async () => "ok");
    await expect(p2).resolves.toBe("ok");
  });
});
