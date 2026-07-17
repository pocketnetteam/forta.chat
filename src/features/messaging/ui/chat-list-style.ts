/**
 * Inline style for the chat MessageList root.
 *
 * Extracted as a pure function so the layout contract can be unit-tested
 * without mounting the heavyweight `MessageList.vue` (Pinia + virtual scroller
 * + dozens of sub-components).
 *
 * `--emoji-picker-height` is published by `EmojiPicker.vue` in input mode and
 * reserves room at the bottom of the chat scrolу so the latest messages stay
 * visible above the docked picker (Telegram-like behavior).
 */

import type { CSSProperties } from "vue";

export function computeChatListStyle(
  chatWallpaper: string | null | undefined,
): CSSProperties {
  return {
    paddingBottom: "var(--emoji-picker-height, 0px)",
    transition: "padding-bottom 200ms ease",
    ...(chatWallpaper ? { background: chatWallpaper } : {}),
  };
}
