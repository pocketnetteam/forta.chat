import { describe, it, expect } from "vitest";
import { searchEmojis, ALL_EMOJIS } from "../emoji-data";

// WEE-34 / forta-bugs#806: emoji search must work in the user's native
// language. Russian queries used to return an empty list because the keyword
// index was English-only.
describe("searchEmojis — native-language (Russian) search", () => {
  it("returns [] for an empty query", () => {
    expect(searchEmojis("")).toEqual([]);
    expect(searchEmojis("   ")).toEqual([]);
  });

  it("finds ❤️ when searching 'сердце' (Russian)", () => {
    const results = searchEmojis("сердце");
    expect(results).toContain("❤️");
  });

  it("finds 🔥 when searching 'огонь' (Russian)", () => {
    const results = searchEmojis("огонь");
    expect(results).toContain("\u{1F525}");
  });

  it("finds 👍 when searching 'лайк' (Russian)", () => {
    const results = searchEmojis("лайк");
    expect(results).toContain("\u{1F44D}");
  });

  it("finds 😂 when searching 'смех' (Russian)", () => {
    const results = searchEmojis("смех");
    expect(results).toContain("\u{1F602}");
  });

  it("is case-insensitive for Cyrillic queries", () => {
    expect(searchEmojis("СЕРДЦЕ")).toContain("❤️");
  });

  it("pulls a whole category by its Russian label ('животные')", () => {
    const results = searchEmojis("животные");
    expect(results).toContain("\u{1F436}"); // 🐶
  });

  it("does NOT regress English search ('heart' still finds ❤️)", () => {
    expect(searchEmojis("heart")).toContain("❤️");
  });

  it("English keyword search still works for 'fire'", () => {
    expect(searchEmojis("fire")).toContain("\u{1F525}");
  });

  it("returns only known emoji (every result is a real catalog entry)", () => {
    const catalog = new Set(ALL_EMOJIS);
    for (const e of searchEmojis("сердце")) {
      expect(catalog.has(e)).toBe(true);
    }
  });
});
