import { describe, it, expect, vi } from "vitest";
import { PromisePool } from "./promise-pool";

describe("PromisePool", () => {
  describe("dedupe", () => {
    it("returns the same promise for concurrent calls with the same key", async () => {
      const pool = new PromisePool<string>();
      const fn = vi.fn(async () => {
        await new Promise(r => setTimeout(r, 10));
        return "result";
      });

      const p1 = pool.dedupe("key1", fn);
      const p2 = pool.dedupe("key1", fn);
      const p3 = pool.dedupe("key1", fn);

      expect(fn).toHaveBeenCalledTimes(1);
      const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
      expect(r1).toBe("result");
      expect(r2).toBe("result");
      expect(r3).toBe("result");
    });

    it("allows new requests after previous one resolves", async () => {
      const pool = new PromisePool<string>();
      let callCount = 0;
      const fn = async () => {
        callCount++;
        return `call-${callCount}`;
      };

      const r1 = await pool.dedupe("key1", fn);
      expect(r1).toBe("call-1");

      const r2 = await pool.dedupe("key1", fn);
      expect(r2).toBe("call-2");
      expect(callCount).toBe(2);
    });

    it("cleans up after rejection", async () => {
      const pool = new PromisePool<string>();
      const fn = vi.fn(async () => { throw new Error("fail"); });

      await expect(pool.dedupe("key1", fn)).rejects.toThrow("fail");
      expect(pool.has("key1")).toBe(false);

      // New call should work
      const fn2 = vi.fn(async () => "ok");
      const r = await pool.dedupe("key1", fn2);
      expect(r).toBe("ok");
      expect(fn2).toHaveBeenCalledTimes(1);
    });

    it("handles different keys independently", async () => {
      const pool = new PromisePool<string>();
      const fn1 = vi.fn(async () => "a");
      const fn2 = vi.fn(async () => "b");

      const [r1, r2] = await Promise.all([
        pool.dedupe("key1", fn1),
        pool.dedupe("key2", fn2),
      ]);

      expect(fn1).toHaveBeenCalledTimes(1);
      expect(fn2).toHaveBeenCalledTimes(1);
      expect(r1).toBe("a");
      expect(r2).toBe("b");
    });
  });

  describe("dedupeBatch", () => {
    it("calls batchFn only for keys not already in-flight", async () => {
      const pool = new PromisePool<void>();
      let resolveFirst!: () => void;
      const firstPromise = new Promise<void>(r => { resolveFirst = r; });

      // Start an in-flight request for "a"
      const p1 = pool.dedupe("a", () => firstPromise);

      // Now batch-request ["a", "b", "c"]
      const batchFn = vi.fn(async () => {});
      const batchPromise = pool.dedupeBatch(["a", "b", "c"], batchFn);

      // batchFn should be called only with ["b", "c"] (not "a")
      expect(batchFn).toHaveBeenCalledTimes(1);
      expect(batchFn).toHaveBeenCalledWith(["b", "c"]);

      resolveFirst();
      const result = await batchPromise;
      await p1;

      expect(result).toEqual(["b", "c"]);
    });

    it("returns empty array when all keys are already in-flight", async () => {
      const pool = new PromisePool<void>();
      let resolve!: () => void;
      const pending = new Promise<void>(r => { resolve = r; });

      pool.dedupe("a", () => pending);
      pool.dedupe("b", () => pending);

      const batchFn = vi.fn(async () => {});
      const resultPromise = pool.dedupeBatch(["a", "b"], batchFn);

      expect(batchFn).not.toHaveBeenCalled();

      resolve();
      const result = await resultPromise;
      expect(result).toEqual([]);
    });

    it("registers all keys synchronously before await — closing race window", async () => {
      const pool = new PromisePool<void>();
      const batchFn = vi.fn(async () => {
        await new Promise(r => setTimeout(r, 50));
      });

      // Fire batch for ["a", "b"]
      const p1 = pool.dedupeBatch(["a", "b"], batchFn);

      // Immediately check — both should be registered
      expect(pool.has("a")).toBe(true);
      expect(pool.has("b")).toBe(true);

      // Second batch for overlapping keys — should not create new requests
      const batchFn2 = vi.fn(async () => {});
      const p2 = pool.dedupeBatch(["a", "b", "c"], batchFn2);

      // Only "c" should be new
      expect(batchFn2).toHaveBeenCalledTimes(1);
      expect(batchFn2).toHaveBeenCalledWith(["c"]);

      await Promise.all([p1, p2]);
      expect(batchFn).toHaveBeenCalledTimes(1);
    });

    it("cleans up keys after batch completes", async () => {
      const pool = new PromisePool<void>();
      await pool.dedupeBatch(["a", "b"], async () => {});

      expect(pool.has("a")).toBe(false);
      expect(pool.has("b")).toBe(false);
      expect(pool.size).toBe(0);
    });

    it("cleans up keys after batch rejects", async () => {
      const pool = new PromisePool<void>();
      await pool.dedupeBatch(["a", "b"], async () => {
        throw new Error("batch fail");
      }).catch(() => {});

      expect(pool.has("a")).toBe(false);
      expect(pool.has("b")).toBe(false);
    });
  });

  describe("has / size", () => {
    it("reports in-flight status correctly", async () => {
      const pool = new PromisePool<void>();
      let resolve!: () => void;
      const pending = new Promise<void>(r => { resolve = r; });

      expect(pool.has("a")).toBe(false);
      expect(pool.size).toBe(0);

      pool.dedupe("a", () => pending);
      expect(pool.has("a")).toBe(true);
      expect(pool.size).toBe(1);

      resolve();
      await pending;
      // After microtask, should be cleaned up
      await new Promise(r => setTimeout(r, 0));
      expect(pool.has("a")).toBe(false);
      expect(pool.size).toBe(0);
    });
  });
});
