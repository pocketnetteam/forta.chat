export type Segment =
  | { type: "text"; content: string }
  | { type: "link"; content: string; href: string }
  | { type: "mention"; content: string; userId: string }
  | { type: "bastyonLink"; content: string; txid: string; isVideo: boolean };

const URL_RE = /https?:\/\/[^\s<>]+|www\.[^\s<>]+/g;

/** Reject dangerous or private-network URLs */
function isSafeUrl(url: string): boolean {
  try {
    const parsed = new URL(url.startsWith("www.") ? `https://${url}` : url);
    const protocol = parsed.protocol;
    if (protocol !== "http:" && protocol !== "https:") return false;
    const hostname = parsed.hostname;
    if (hostname === "localhost" || hostname === "127.0.0.1") return false;
    // Private IP ranges
    const ipMatch = hostname.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    if (ipMatch) {
      const [, a, b] = ipMatch.map(Number);
      if (a === 10) return false;
      if (a === 192 && b === 168) return false;
      if (a === 172 && b >= 16 && b <= 31) return false;
      if (a === 127) return false;
    }
    return true;
  } catch {
    return false;
  }
}
const BASTYON_RE = /(?:bastyon:\/\/|https?:\/\/(?:bastyon\.com|pocketnet\.app)\/)(?:index|post)\?[vs]=([a-f0-9]{64})(?:[&\w=]*)/gi;
// Bastyon mention format: @<34-68 hex-char address>:<display_name>
// Display name may contain unicode (Cyrillic etc.), underscores, digits
const MENTION_RE = /@(\w{34,68}):([\p{L}\p{N}_]{1,50})/gu;

/**
 * Strip hex addresses from mentions for plain-text preview.
 * "@50486457...5:Daniel_Satchkov" → "@Daniel_Satchkov"
 */
export function stripMentionAddresses(text: string): string {
  if (!text) return "";
  // Use a fresh regex (since MENTION_RE is global and has state)
  return text.replace(/@\w{34,68}:([\p{L}\p{N}_]{1,50})/gu, (_match, name) => `@${name}`);
}

/**
 * Replace bastyon:// and bastyon.com post links with a short label for previews.
 * "Check this bastyon://index?s=abc123...def" → "Check this [Bastyon post]"
 */
export function stripBastyonLinks(text: string): string {
  if (!text) return "";
  return text.replace(
    /(?:bastyon:\/\/|https?:\/\/(?:bastyon\.com|pocketnet\.app)\/)(?:index|post)\?[vs]=[a-f0-9]{64}(?:[&\w=]*)/gi,
    "📝 Bastyon post",
  );
}

/**
 * Parse a message string into renderable segments: plain text, links, and mentions.
 * Segments are returned in the order they appear in the input.
 */
export function parseMessage(text: string): Segment[] {
  if (!text) return [{ type: "text", content: "" }];

  // Collect all matches with their positions
  const matches: { start: number; end: number; segment: Segment }[] = [];

  // Bastyon post links (check before generic URLs so they take priority)
  const bastyonRanges: [number, number][] = [];
  for (const m of text.matchAll(BASTYON_RE)) {
    const start = m.index!;
    const end = start + m[0].length;
    const isVideo = /index\?v=/.test(m[0]) || /[&?]video=1/.test(m[0]);
    bastyonRanges.push([start, end]);
    matches.push({
      start,
      end,
      segment: { type: "bastyonLink", content: m[0], txid: m[1], isVideo },
    });
  }

  // Links (skip ranges already claimed by bastyonLink)
  for (const m of text.matchAll(URL_RE)) {
    const start = m.index!;
    const end = start + m[0].length;
    const overlap = bastyonRanges.some(([bs, be]) => start < be && end > bs);
    if (overlap) continue;
    const href = m[0].startsWith("www.") ? `https://${m[0]}` : m[0];
    if (!isSafeUrl(href)) continue;
    matches.push({
      start,
      end,
      segment: { type: "link", content: m[0], href },
    });
  }

  // Mentions: @hexaddr:displayName
  for (const m of text.matchAll(MENTION_RE)) {
    // Skip if this range overlaps with a link
    const start = m.index!;
    const end = start + m[0].length;
    const overlaps = matches.some(
      (existing) => start < existing.end && end > existing.start,
    );
    if (overlaps) continue;

    matches.push({
      start,
      end,
      segment: { type: "mention", content: `@${m[2]}`, userId: m[1] },
    });
  }

  if (matches.length === 0) {
    return [{ type: "text", content: text }];
  }

  // Sort by start position
  matches.sort((a, b) => a.start - b.start);

  // Build segments from gaps and matches
  const segments: Segment[] = [];
  let cursor = 0;

  for (const match of matches) {
    if (match.start > cursor) {
      segments.push({ type: "text", content: text.slice(cursor, match.start) });
    }
    segments.push(match.segment);
    cursor = match.end;
  }

  if (cursor < text.length) {
    segments.push({ type: "text", content: text.slice(cursor) });
  }

  return segments;
}
