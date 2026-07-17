import { describe, it, expect } from "vitest";
import { computeChatListStyle } from "../chat-list-style";

describe("computeChatListStyle", () => {
  it("reserves bottom space for the docked EmojiPicker via CSS var", () => {
    const style = computeChatListStyle(null);
    expect(style.paddingBottom).toBe("var(--emoji-picker-height, 0px)");
  });

  it("animates padding-bottom so the layout shift is not abrupt", () => {
    const style = computeChatListStyle(null);
    expect(style.transition).toContain("padding-bottom");
  });

  it("preserves chat wallpaper background when set", () => {
    const wallpaper = "url('/wallpapers/forest.jpg') center/cover";
    const style = computeChatListStyle(wallpaper);
    expect(style.background).toBe(wallpaper);
    expect(style.paddingBottom).toBe("var(--emoji-picker-height, 0px)");
  });

  it("omits background when no wallpaper is configured", () => {
    const style = computeChatListStyle(null);
    expect("background" in style).toBe(false);
  });

  it("omits background when wallpaper is an empty string (treat as falsy)", () => {
    const style = computeChatListStyle("");
    expect("background" in style).toBe(false);
  });
});
