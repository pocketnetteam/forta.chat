import { describe, it, expect } from "vitest";
import { getChannelPreviewText } from "./channel-preview";
import type { Channel, ChannelPost } from "../model/types";

/**
 * WEE-101 — a repost ("share") as the channel's latest post has empty
 * caption/message, so the old `caption || message` preview rendered an
 * empty sidebar row. Empty text must fall back to a type-aware label.
 */

const t = (key: string): string => key;

function makeChannel(lastContent: Partial<ChannelPost> | null): Channel {
  return {
    address: "PChannelAddr",
    name: "Channel",
    avatar: "",
    lastContent: lastContent
      ? {
          txid: "tx1",
          type: "share",
          caption: "",
          message: "",
          time: 1000,
          height: 1,
          scoreSum: 0,
          scoreCnt: 0,
          comments: 0,
          ...lastContent,
        }
      : null,
  };
}

describe("getChannelPreviewText (WEE-101)", () => {
  it("репост без caption/message → label «Репост», не пустая строка", () => {
    expect(getChannelPreviewText(makeChannel({ type: "share" }), t))
      .toBe("🔁 channels.repostPreview");
  });

  it("обычный текстовый пост показывает caption", () => {
    expect(getChannelPreviewText(makeChannel({ caption: "hello" }), t)).toBe("hello");
  });

  it("длинный текст усечён до 80 символов с многоточием", () => {
    const long = "a".repeat(100);
    const result = getChannelPreviewText(makeChannel({ message: long }), t);
    expect(result).toBe("a".repeat(80) + "...");
  });

  it("пост без текста, но с картинками → photo-label", () => {
    expect(getChannelPreviewText(makeChannel({ images: ["img1"] }), t))
      .toBe("📷 message.photo");
  });

  it("видео-пост без текста → video-label", () => {
    expect(getChannelPreviewText(makeChannel({ type: "video", url: "peertube://x" }), t))
      .toBe("🎬 post.video");
  });

  it("нет lastContent → пустая строка", () => {
    expect(getChannelPreviewText(makeChannel(null), t)).toBe("");
  });
});
