/**
 * Bastyon post/comment link parser and normalizer.
 *
 * Handles all known URL formats:
 *   - bastyon://post?s={txid}
 *   - bastyon://index?v={txid}
 *   - https://bastyon.com/post?s={txid}
 *   - https://pocketnet.app/post?s={txid}
 *   - https://forta.chat/post?s={txid}
 *   - All above with &c={commentId} or #comment-{commentId}
 */

export interface BastyonLinkTarget {
  txid: string; // 64-char lowercase hex
  commentId?: string; // optional comment txid
  isVideo: boolean;
}

const BASTYON_HOSTS = ["bastyon.com", "pocketnet.app", "forta.chat"];

const HEX64_RE = /^[a-f0-9]{64}$/;

/**
 * Regex for detecting Bastyon links inside message text.
 *
 * Matches:
 *   bastyon://(post|index)?...s|v=HEX64...
 *   https://(bastyon.com|pocketnet.app|forta.chat)/(post|index)?...s|v=HEX64...
 *
 * Captures group 1: the 64-char hex txid (from the first s= or v= param).
 *
 * Intentionally broad on trailing query/fragment — actual extraction
 * is delegated to parseBasytonLink() which uses the URL API.
 */
export const BASTYON_LINK_RE = new RegExp(
  "(?:" +
    "bastyon:\\/\\/" +
    "|" +
    "https?:\\/\\/(?:" +
    BASTYON_HOSTS.map((h) => h.replace(/\./g, "\\.")).join("|") +
    ")\\/" +
    ")" +
    "(?:index|post)" +
    "\\?" +
    "(?:[\\w]+=(?:[\\w%-]*?)&)*" +
    "[vs]=([a-fA-F0-9]{64})" +
    "(?:&[\\w]+=(?:[\\w%-]*))*" +
    "(?:#[\\w-]*)?",
  "gi",
);

/**
 * Parse a single Bastyon URL into a normalized target.
 * Returns null if the URL is not a valid Bastyon link.
 */
export function parseBasytonLink(url: string): BastyonLinkTarget | null {
  const lower = url.toLowerCase();
  if (
    !lower.startsWith("bastyon://") &&
    !BASTYON_HOSTS.some((h) => lower.includes(h))
  ) {
    return null;
  }

  try {
    // Normalize bastyon:// to parseable https:// URL
    const normalizedUrl = url.startsWith("bastyon://")
      ? url.replace("bastyon://", "https://bastyon.com/")
      : url;

    const parsed = new URL(normalizedUrl);

    // Validate host (skip for bastyon:// — already normalized)
    if (
      !url.startsWith("bastyon://") &&
      !BASTYON_HOSTS.includes(parsed.hostname)
    ) {
      return null;
    }

    // Validate path
    const path = parsed.pathname.replace(/^\//, "");
    if (path !== "post" && path !== "index") return null;

    // Extract txid — try s= first, then v=
    const txid = (
      parsed.searchParams.get("s") || parsed.searchParams.get("v")
    )?.toLowerCase();
    if (!txid || !HEX64_RE.test(txid)) return null;

    // Extract optional comment ID from &c= param
    let commentId = parsed.searchParams.get("c")?.toLowerCase();
    if (commentId && !HEX64_RE.test(commentId)) {
      commentId = undefined;
    }

    // Fallback: check fragment #comment-{hex64}
    if (!commentId && parsed.hash) {
      const fragMatch = parsed.hash.match(
        /^#comment-([a-fA-F0-9]{64})$/i,
      );
      if (fragMatch) commentId = fragMatch[1].toLowerCase();
    }

    const isVideo =
      path === "index" ||
      parsed.searchParams.has("v") ||
      parsed.searchParams.get("video") === "1";

    return { txid, commentId, isVideo };
  } catch {
    return null;
  }
}

/**
 * Generate canonical bastyon:// URL from a parsed target.
 */
export function toBasytonUrl(target: BastyonLinkTarget): string {
  const path = target.isVideo ? "index" : "post";
  const param = target.isVideo ? "v" : "s";
  let url = `bastyon://${path}?${param}=${target.txid}`;
  if (target.commentId) url += `&c=${target.commentId}`;
  return url;
}

/**
 * Generate HTTPS sharing URL from a parsed target.
 */
export function toBasytonHttpsUrl(target: BastyonLinkTarget): string {
  const path = target.isVideo ? "index" : "post";
  const param = target.isVideo ? "v" : "s";
  let url = `https://bastyon.com/${path}?${param}=${target.txid}`;
  if (target.commentId) url += `&c=${target.commentId}`;
  return url;
}
