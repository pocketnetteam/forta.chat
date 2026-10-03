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

import { MATRIX_ROOM_ID_RE } from "./parse-invite-url";

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

/** HTTPS URL of a post — what Forta shares and copies (opens without the Bastyon app). */
export function toBastyonPostHttpsUrl(txid: string): string {
  return toBasytonHttpsUrl({ txid, isVideo: false });
}

// ─── Collections ──────────────────────────────────────────────────

/**
 * Bastyon collection link (shared from the collection page in Bastyon):
 *   - bastyon://collection?c={txid}
 *   - https://(bastyon.com|pocketnet.app|forta.chat)/collection?c={txid}
 *
 * Captures group 1: the 64-char hex collection txid.
 */
export const BASTYON_COLLECTION_LINK_RE = new RegExp(
  "(?:" +
    "bastyon:\\/\\/" +
    "|" +
    "https?:\\/\\/(?:" +
    BASTYON_HOSTS.map((h) => h.replace(/\./g, "\\.")).join("|") +
    ")\\/" +
    ")" +
    "collection\\/?" +
    "\\?" +
    "(?:[\\w]+=(?:[\\w%-]*?)&)*" +
    "c=([a-fA-F0-9]{64})" +
    "(?:&[\\w]+=(?:[\\w%-]*))*" +
    "(?:#[\\w-]*)?",
  "gi",
);

/**
 * Parse a Bastyon collection URL. Returns the collection txid or null
 * when the URL is not a valid collection link.
 */
export function parseBastyonCollectionLink(url: string): { txid: string } | null {
  const lower = url.toLowerCase();
  const isScheme = lower.startsWith("bastyon://");
  if (!isScheme && !BASTYON_HOSTS.some((h) => lower.includes(h))) return null;

  try {
    const parsed = new URL(isScheme ? url.replace(/^bastyon:\/\//i, "https://bastyon.com/") : url);
    if (!isScheme && !BASTYON_HOSTS.includes(parsed.hostname)) return null;

    const path = parsed.pathname.replace(/^\/|\/$/g, "");
    if (path !== "collection") return null;

    const txid = parsed.searchParams.get("c")?.toLowerCase();
    if (!txid || !HEX64_RE.test(txid)) return null;

    return { txid };
  } catch {
    return null;
  }
}

/** True for links rendered as block cards in messages (post, collection,
 *  profile, room, transaction) — an OG link preview of such a URL would
 *  duplicate the card. */
export function isBastyonBlockUrl(url: string): boolean {
  if (!url) return false;
  return !!(
    parseBasytonLink(url)
    || parseBastyonCollectionLink(url)
    || parseBastyonProfileLink(url)
    || parseBastyonRoomLink(url)
    || parseBastyonTransactionLink(url)
  );
}

/** Canonical bastyon:// URL of a collection (deep link into the Bastyon app). */
export function toBastyonCollectionUrl(txid: string): string {
  return `bastyon://collection?c=${txid}`;
}

/** HTTPS URL of a collection on bastyon.com. */
export function toBastyonCollectionHttpsUrl(txid: string): string {
  return `https://bastyon.com/collection?c=${txid}`;
}

// ─── Custom scheme (bastyon:// / pocketnet://) ────────────────────

/**
 * Any `bastyon://` / `pocketnet://` deep link inside message text, whatever it
 * points to (post, profile, collection, welcome?connect=…). Trailing sentence
 * punctuation is excluded so "see bastyon://name." does not swallow the dot.
 */
export const BASTYON_SCHEME_LINK_RE =
  /\b(?:bastyon|pocketnet):\/\/[^\s<>"'`]*[^\s<>"'`.,!?;:)\]}»…]/gi;

const SCHEME_PREFIX_RE = /^(?:bastyon|pocketnet):\/\//i;

/**
 * Rewrite a `bastyon://` / `pocketnet://` deep link to its https://bastyon.com
 * form (the same mapping Bastyon's formatInternalLink does). Other URLs are
 * returned unchanged.
 */
export function bastyonSchemeToHttps(url: string): string {
  if (!SCHEME_PREFIX_RE.test(url)) return url;
  return url.replace(SCHEME_PREFIX_RE, "https://bastyon.com/");
}

/**
 * Replace every Bastyon deep link in a text with its https://bastyon.com form.
 * Used when a message is copied, so the clipboard gets a link that opens
 * anywhere (browser, other messengers) — as the old Bastyon chat did.
 */
export function bastyonLinksToHttps(text: string): string {
  if (!text) return text;
  return text.replace(BASTYON_SCHEME_LINK_RE, (m: string, offset: number) =>
    // `…?to=bastyon://x` is a parameter of another URL — leave it alone.
    offset > 0 && !/[\s([{«"'<>]/.test(text[offset - 1]) ? m : bastyonSchemeToHttps(m),
  );
}

// ─── Profiles (channels) ──────────────────────────────────────────

/** A link to a Bastyon user: by username (`bastyon://name`) or by address. */
export interface BastyonProfileTarget {
  name?: string;
  address?: string;
}

/** Bastyon pages (routes of pocketnet's _map.js) — a single path segment with
 *  one of these names is a page, not a username. Lowercase. */
const BASTYON_RESERVED_PATHS = new Set([
  "", "index", "post", "collection", "collections", "newcollection", "author", "authorn", "user", "userpage",
  "channel", "welcome", "docs", "blockexplorer", "embedvideo.php", "openapi.html", "faq", "about", "aboutus",
  "terms", "help", "support", "home", "lenta", "share", "registration", "authorization", "wallet", "boost",
  "boosts", "video", "articlev", "articlesv", "search", "searchusers", "userslist", "recommendedusers",
  "notifications", "usersettings", "accounts", "application", "applications", "miniapps", "donate",
  "donations", "earnings", "staking", "pkoin", "howtobuy", "transactionview", "comments", "lastcomments",
  "tagcloud", "complain", "test", "page404", "csaepolicy", "advertising", "monetization", "categories",
]);

/** forta.chat is left out: its own routes would read as usernames. */
const BASTYON_SITE_HOSTS = ["bastyon.com", "pocketnet.app"];

const BASTYON_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{34}$/;
const BASTYON_USERNAME_RE = /^[\p{L}\p{N}_-]{1,40}$/u;

/** A bastyon:// deep link or a bastyon.com / pocketnet.app URL as a URL
 *  object; null for anything else. */
function parseBastyonUrl(url: string): URL | null {
  if (!url) return null;
  const isScheme = SCHEME_PREFIX_RE.test(url);
  const lower = url.toLowerCase();
  if (!isScheme && !BASTYON_SITE_HOSTS.some((h) => lower.includes(h))) return null;
  try {
    const parsed = new URL(bastyonSchemeToHttps(url));
    if (!isScheme && !BASTYON_SITE_HOSTS.includes(parsed.hostname.replace(/^www\./, ""))) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Parse a link to a Bastyon profile:
 *   - bastyon://{username}[?ref=…]           (shared from the Bastyon app)
 *   - https://bastyon.com/{username}[?ref=…]
 *   - bastyon://author?address={address}, …/user?address={address}
 *   - bastyon://welcome?connect={address}    ("write to me" invite)
 * Returns null for posts, collections, rooms, transactions, Bastyon pages
 * and foreign hosts.
 */
export function parseBastyonProfileLink(url: string): BastyonProfileTarget | null {
  const parsed = parseBastyonUrl(url);
  if (!parsed) return null;
  const params = parsed.searchParams;

  // Post / video / collection / room / transaction links have their own cards.
  if (params.has("s") || params.has("v") || params.has("publicroom") || params.has("stx")) return null;

  // Like Bastyon's widgets.url(): connect= wins over the path.
  if (params.has("connect")) {
    const address = params.get("connect") ?? "";
    return BASTYON_ADDRESS_RE.test(address) ? { address } : null;
  }

  const path = parsed.pathname.replace(/^\/|\/$/g, "");
  const pathLower = path.toLowerCase();

  if (pathLower === "author" || pathLower === "user" || pathLower === "channel") {
    const address = params.get("address") ?? "";
    return BASTYON_ADDRESS_RE.test(address) ? { address } : null;
  }

  if (path.includes("/") || BASTYON_RESERVED_PATHS.has(pathLower)) return null;
  let name: string;
  try {
    name = decodeURIComponent(path);
  } catch {
    return null;
  }
  return BASTYON_USERNAME_RE.test(name) ? { name } : null;
}

// ─── Rooms and transactions ───────────────────────────────────────

/**
 * Bastyon public room link (old Bastyon chat "share room"):
 *   https://bastyon.com/welcome?publicroom={matrixRoomId}, bastyon://welcome?publicroom=…
 */
export function parseBastyonRoomLink(url: string): { roomId: string } | null {
  const roomId = parseBastyonUrl(url)?.searchParams.get("publicroom") ?? "";
  return MATRIX_ROOM_ID_RE.test(roomId) ? { roomId } : null;
}

/**
 * Bastyon transaction link: bastyon://i?stx={txid}, https://bastyon.com/…?stx={txid}
 */
export function parseBastyonTransactionLink(url: string): { txid: string } | null {
  const txid = parseBastyonUrl(url)?.searchParams.get("stx")?.toLowerCase() ?? "";
  return HEX64_RE.test(txid) ? { txid } : null;
}

/** Block explorer page of a transaction (same explorer as TransferCard). */
export function toTransactionExplorerUrl(txid: string): string {
  return `https://explorer.pocketnet.app/tx/${txid}`;
}
