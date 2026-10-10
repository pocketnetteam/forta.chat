import { describe, it, expect } from "vitest";
import { reuseIfSameKeys } from "./stable-scroller-items";

const items = (...keys: string[]) => keys.map(k => ({ _key: k, v: Math.random() }));

describe("reuseIfSameKeys", () => {
  it("keeps the previous array when only row contents changed", () => {
    const prev = items("a", "b", "c");
    const next = items("a", "b", "c");
    expect(reuseIfSameKeys(prev, next)).toBe(prev);
  });

  it("takes the new array when rows were reordered", () => {
    const prev = items("a", "b", "c");
    const next = items("b", "a", "c");
    expect(reuseIfSameKeys(prev, next)).toBe(next);
  });

  it("takes the new array when a row was added or removed", () => {
    const prev = items("a", "b");
    expect(reuseIfSameKeys(prev, items("a", "b", "c"))).not.toBe(prev);
    expect(reuseIfSameKeys(prev, items("a"))).not.toBe(prev);
  });

  it("takes the new array on first run", () => {
    const next = items("a");
    expect(reuseIfSameKeys(null, next)).toBe(next);
  });
});
