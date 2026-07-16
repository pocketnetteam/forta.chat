import type { Channel } from "../model/types";

const PREVIEW_MAX_LENGTH = 80;

type PreviewLabelKey =
  | "message.photo"
  | "post.video"
  | "channels.repostPreview"
  | "channels.postPreview";

/**
 * Sidebar preview text for a channel's latest post.
 *
 * Reposts (Bastyon "share") carry no caption/message of their own, so a plain
 * `caption || message` renders an empty sidebar row (WEE-101). When the text
 * is empty, fall back to a type-aware label instead.
 */
export function getChannelPreviewText(
  channel: Channel,
  t: (key: PreviewLabelKey) => string,
): string {
  const last = channel.lastContent;
  if (!last) return "";

  const text = last.caption || last.message || "";
  if (text) {
    return text.length > PREVIEW_MAX_LENGTH ? text.slice(0, PREVIEW_MAX_LENGTH) + "..." : text;
  }

  if (last.images?.length) return `📷 ${t("message.photo")}`;
  if (last.url) return `🎬 ${t("post.video")}`;
  if (last.type === "share") return `🔁 ${t("channels.repostPreview")}`;
  return `📝 ${t("channels.postPreview")}`;
}
