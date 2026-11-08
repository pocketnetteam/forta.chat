import { describe, it, expect, vi } from "vitest";
import { LocalNodeCache } from "./cache";

describe("LocalNodeCache", () => {
  it("caches getnodeinfo and dedupes inflight", async () => {
    let now = 1_000;
    const cache = new LocalNodeCache({ now: () => now });
    const key = cache.cacheKey("getnodeinfo", []);
    expect(key).toBeTruthy();

    const produce = vi.fn(async () => ({ height: 1 }));
    const a = cache.wrap(key, "getnodeinfo", false, produce);
    const b = cache.wrap(key, "getnodeinfo", false, produce);
    await expect(Promise.all([a, b])).resolves.toEqual([{ height: 1 }, { height: 1 }]);
    expect(produce).toHaveBeenCalledTimes(1);

    const c = await cache.wrap(key, "getnodeinfo", false, produce);
    expect(c).toEqual({ height: 1 });
    expect(produce).toHaveBeenCalledTimes(1);

    now += 20_000;
    await cache.wrap(key, "getnodeinfo", false, produce);
    expect(produce).toHaveBeenCalledTimes(2);
  });

  it("skips cache for unknown methods", () => {
    const cache = new LocalNodeCache();
    expect(cache.cacheKey("unknownmethod", [])).toBeNull();
  });
});
