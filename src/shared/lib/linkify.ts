/**
 * Plain-text URL detection for Bastyon post bodies (card preview + full view).
 *
 * Chat messages go through `parseMessage` (mentions, bastyon embeds); posts
 * only need "text vs link", plus two post-specific concerns: trailing
 * sentence punctuation must not leak into the href, and the card preview is
 * truncated, which must never cut a link's target in half.
 */
import { isSafeUrl } from "./message-format";

export type LinkSegment =
  | { type: "text"; content: string }
  | { type: "link"; content: string; href: string };

const URL_RE = /https?:\/\/[^\s<>"]+|www\.[^\s<>"]+/g;
const TRAILING_PUNCT_RE = /[.,;:!?'»]+$/;

/** Drop sentence punctuation and an unbalanced closing paren from a URL match. */
function trimUrl(raw: string): string {
  let url = raw.replace(TRAILING_PUNCT_RE, "");
  while (url.endsWith(")") && (url.match(/\(/g)?.length ?? 0) < (url.match(/\)/g)?.length ?? 0)) {
    url = url.slice(0, -1).replace(TRAILING_PUNCT_RE, "");
  }
  return url;
}

/** Split text into plain-text and safe http(s) link segments, in order. */
export function parseTextLinks(text: string): LinkSegment[] {
  if (!text) return [];
  const segments: LinkSegment[] = [];
  let cursor = 0;
  for (const m of text.matchAll(URL_RE)) {
    const url = trimUrl(m[0]);
    const href = url.startsWith("www.") ? `https://${url}` : url;
    if (!url || !isSafeUrl(href)) continue;
    const start = m.index!;
    if (start > cursor) segments.push({ type: "text", content: text.slice(cursor, start) });
    segments.push({ type: "link", content: url, href });
    cursor = start + url.length;
  }
  if (cursor < text.length) segments.push({ type: "text", content: text.slice(cursor) });
  return segments;
}

/**
 * Truncate segments to `maxLength` visible code points, appending "...".
 * A link cut mid-way keeps its full href, only its label is shortened.
 */
export function truncateLinkSegments(segments: LinkSegment[], maxLength: number): LinkSegment[] {
  const out: LinkSegment[] = [];
  let remaining = maxLength;
  for (const seg of segments) {
    const chars = Array.from(seg.content);
    if (chars.length <= remaining) {
      out.push(seg);
      remaining -= chars.length;
      continue;
    }
    const content = chars.slice(0, remaining).join("") + "...";
    out.push(seg.type === "link" ? { ...seg, content } : { type: "text", content });
    return out;
  }
  return out;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Escape plain text for v-html and wrap detected URLs in external anchors. */
export function linkifyToHtml(text: string): string {
  return parseTextLinks(text)
    .map((seg) =>
      seg.type === "link"
        ? `<a href="${escapeHtml(seg.href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(seg.content)}</a>`
        : escapeHtml(seg.content),
    )
    .join("");
}
