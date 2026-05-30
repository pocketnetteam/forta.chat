import { describe, it, expect } from "vitest";
import { insertEmojiAtCursor } from "../emoji-insertion";

describe("insertEmojiAtCursor — WEE-48 / forta-bugs#483, #489", () => {
  it("inserts at cursor and reports the new caret position", () => {
    const r = insertEmojiAtCursor({ text: "hello world", selectionStart: 5, selectionEnd: 5, emoji: "😀" });
    expect(r.text).toBe("hello😀 world");
    expect(r.cursor).toBe(5 + "😀".length);
    expect(r.changed).toBe(true);
  });

  it("replaces the active selection (does not duplicate)", () => {
    const r = insertEmojiAtCursor({ text: "hello world", selectionStart: 0, selectionEnd: 5, emoji: "👋" });
    expect(r.text).toBe("👋 world");
    expect(r.cursor).toBe("👋".length);
  });

  it("appends to end when selection is at end", () => {
    const r = insertEmojiAtCursor({ text: "hi", selectionStart: 2, selectionEnd: 2, emoji: "🚀" });
    expect(r.text).toBe("hi🚀");
    expect(r.cursor).toBe(2 + "🚀".length);
  });

  it("is a no-op for an empty emoji (changed=false)", () => {
    const r = insertEmojiAtCursor({ text: "abc", selectionStart: 1, selectionEnd: 1, emoji: "" });
    expect(r.changed).toBe(false);
    expect(r.text).toBe("abc");
    expect(r.cursor).toBe(1);
  });

  it("clamps out-of-range selectionStart/End to text length", () => {
    const r = insertEmojiAtCursor({ text: "abc", selectionStart: 99, selectionEnd: 99, emoji: "✨" });
    expect(r.text).toBe("abc✨");
    expect(r.cursor).toBe("abc✨".length);
  });

  it("handles selectionEnd < selectionStart by ignoring the inversion", () => {
    const r = insertEmojiAtCursor({ text: "abcdef", selectionStart: 4, selectionEnd: 2, emoji: "⭐" });
    // start dominates — emit at start, do not delete a backwards range
    expect(r.text).toBe("abcd⭐ef");
    expect(r.cursor).toBe(4 + "⭐".length);
  });

  it("handles NaN selection (e.g. detached textarea) by inserting at start", () => {
    const r = insertEmojiAtCursor({ text: "abc", selectionStart: Number.NaN, selectionEnd: Number.NaN, emoji: "🎉" });
    expect(r.text).toBe("🎉abc");
    expect(r.cursor).toBe("🎉".length);
  });
});
