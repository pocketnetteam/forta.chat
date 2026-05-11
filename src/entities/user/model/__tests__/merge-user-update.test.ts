import { describe, it, expect } from "vitest";
import { mergeUserUpdate } from "../merge-user-update";
import type { User } from "../types";

/**
 * mergeUserUpdate must NEVER overwrite a cached non-empty profile field with
 * an empty value coming from the upstream Pocketnet response.
 *
 * Background (Session 45 — issue #368, "Аватарка ежедневно исчезает из
 * профиля"): the periodic refreshStaleUsers cycle re-fetches profiles every
 * 6 hours. When Pocketnet returns an empty `image` for a user (transient
 * RPC issue, race after edit, etc.) the previous code overwrote the cached
 * avatar with "" — peers then saw the user lose their picture daily.
 */
describe("mergeUserUpdate", () => {
  const baseCached: User = {
    address: "addr-1",
    name: "Alice",
    image: "https://cdn/alice.jpg",
    about: "hi",
    site: "https://alice.dev",
    language: "en",
    cachedAt: 1_000,
  };

  it("returns a new object — never mutates the cached entry", () => {
    const fresh = { name: "Alice 2" };
    const result = mergeUserUpdate(baseCached, fresh);

    expect(result).not.toBe(baseCached);
    expect(baseCached.name).toBe("Alice");
  });

  it("keeps cached image when fresh image is empty string", () => {
    const result = mergeUserUpdate(baseCached, { image: "" });
    expect(result.image).toBe("https://cdn/alice.jpg");
  });

  it("keeps cached image when fresh image is whitespace only", () => {
    const result = mergeUserUpdate(baseCached, { image: "   " });
    expect(result.image).toBe("https://cdn/alice.jpg");
  });

  it("keeps cached name when fresh name is empty string", () => {
    const result = mergeUserUpdate(baseCached, { name: "" });
    expect(result.name).toBe("Alice");
  });

  it("updates image when fresh image is a non-empty URL", () => {
    const result = mergeUserUpdate(baseCached, { image: "https://cdn/new.jpg" });
    expect(result.image).toBe("https://cdn/new.jpg");
  });

  it("updates name when fresh name is non-empty", () => {
    const result = mergeUserUpdate(baseCached, { name: "Bob" });
    expect(result.name).toBe("Bob");
  });

  it("preserves the address from the cached entry", () => {
    const result = mergeUserUpdate(baseCached, { name: "Bob", image: "https://cdn/b.jpg" });
    expect(result.address).toBe("addr-1");
  });

  it("refreshes cachedAt timestamp", () => {
    const result = mergeUserUpdate(baseCached, { name: "Bob" }, 5_000);
    expect(result.cachedAt).toBe(5_000);
  });

  it("uses Date.now() for cachedAt when not provided", () => {
    const before = Date.now();
    const result = mergeUserUpdate(baseCached, { name: "Bob" });
    const after = Date.now();

    expect(result.cachedAt).toBeGreaterThanOrEqual(before);
    expect(result.cachedAt!).toBeLessThanOrEqual(after);
  });

  it("creates a fresh User when prev is null/undefined", () => {
    const result = mergeUserUpdate(null, {
      address: "addr-2",
      name: "Carol",
      image: "https://cdn/c.jpg",
      about: "",
      site: "",
      language: "ru",
    }, 7_000);

    expect(result).toMatchObject({
      address: "addr-2",
      name: "Carol",
      image: "https://cdn/c.jpg",
      language: "ru",
      cachedAt: 7_000,
    });
  });

  it("falls back to '' for missing optional fields when prev is null", () => {
    const result = mergeUserUpdate(null, {
      address: "addr-3",
      name: "Dave",
    }, 9_000);

    expect(result.image).toBe("");
    expect(result.about).toBe("");
    expect(result.site).toBe("");
    expect(result.language).toBe("");
  });
});
