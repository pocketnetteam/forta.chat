import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { LRUCache } from "./lru-cache";

/** Audit W2D-02: the post and score caches grew with every post ever shown. */
describe("LRUCache", () => {
  it("drops the least recently used entry past its cap", () => {
    const cache = new LRUCache<string, number>(2);
    cache.set("a", 1);
    cache.set("b", 2);
    expect(cache.get("a")).toBe(1); // a is now the most recent
    cache.set("c", 3);
    expect(cache.has("b")).toBe(false);
    expect(cache.has("a")).toBe(true);
    expect(cache.size).toBe(2);
  });

  it("caps the channel post cache", () => {
    const root = resolve(__dirname, "../../..");
    const init = readFileSync(resolve(root, "src/app/providers/initializers/app-initializer.ts"), "utf-8");
    expect(init).toContain("private postCache = new LRUCache<string, BastyonPostData>(POST_CACHE_MAX);");
  });
});
