/**
 * Deep-link parser for Forta Chat invite and room-join URLs.
 *
 * Android App Links deliver the URL verbatim; the Vue app itself still uses
 * hash routing (`#/invite?ref=...`), so every parser must accept both shapes
 * plus the `forta://` custom scheme fallback that kicks in when App Links
 * aren't verified.
 *
 *   https://forta.chat/invite?ref=<addr>
 *   https://forta.chat/#/invite?ref=<addr>
 *   https://www.forta.chat/invite?ref=<addr>
 *   forta://invite?ref=<addr>
 *
 * Join-room URLs follow the same pattern but carry `?room=<matrixRoomId>`.
 */

const INVITE_HOSTS = ["forta.chat", "www.forta.chat"];
const CUSTOM_SCHEME = "forta:";

/** Bastyon addresses are base58-flavoured strings of 25–40 alphanumerics.
 *  Anything wider invites injection into Dexie/Matrix call paths.
 *  Exported so callers reuse the exact same shape check — a divergent copy
 *  elsewhere would create a split-brain validation gate. */
export const BASTYON_ADDRESS_RE = /^[A-Za-z0-9]{25,40}$/;

/** Matrix room IDs: `!localpart:server`. Localpart uses the Matrix-specified
 *  charset (`[A-Za-z0-9._=+-]`); notably no `/`, to block traversal-style
 *  payloads like `!../../evil:server`. */
const MATRIX_ROOM_ID_RE = /^![A-Za-z0-9._=+\-]+:[A-Za-z0-9.\-]+(:\d+)?$/;

export interface InviteTarget {
  address: string;
}

export interface JoinTarget {
  roomId: string;
}

export type DeepLinkTarget =
  | ({ kind: "invite" } & InviteTarget)
  | ({ kind: "join" } & JoinTarget);

interface NormalizedUrl {
  /** Logical path (e.g. "invite", "join", "post"), independent of hash vs path. */
  path: string;
  params: URLSearchParams;
  isForta: boolean;
  isCustomScheme: boolean;
}

function normalizeUrl(raw: string): NormalizedUrl | null {
  if (!raw || typeof raw !== "string") return null;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }

  const isCustomScheme = url.protocol === CUSTOM_SCHEME;
  const isForta = isCustomScheme || INVITE_HOSTS.includes(url.hostname);
  if (!isForta) return null;

  // Hash-based routing: `https://forta.chat/#/invite?ref=X`
  // The URL constructor leaves everything after `#` in `hash`, so we need a
  // second pass to pull out the inner path + query.
  if (url.hash && url.hash.length > 1) {
    const hashBody = url.hash.slice(1); // strip leading "#"
    // Accept `#/invite?ref=X`, `#invite?ref=X`, `#/invite/?ref=X`
    const withoutLeadingSlash = hashBody.replace(/^\//, "");
    const [pathPart, queryPart = ""] = withoutLeadingSlash.split("?");
    const cleanPath = pathPart.replace(/\/+$/, "");
    if (cleanPath) {
      return {
        path: cleanPath,
        params: new URLSearchParams(queryPart),
        isForta,
        isCustomScheme,
      };
    }
  }

  // Path-based routing. For `forta://invite?ref=X` the URL API puts "invite"
  // in `hostname` (no authority). Normalize that case first.
  let path: string;
  if (isCustomScheme) {
    // forta://invite?ref=X → hostname="invite", pathname=""
    // forta:///invite?ref=X → hostname="", pathname="/invite"
    path = (url.hostname || url.pathname.replace(/^\//, "")).replace(/\/+$/, "");
  } else {
    path = url.pathname.replace(/^\//, "").replace(/\/+$/, "");
  }

  return {
    path,
    params: url.searchParams,
    isForta,
    isCustomScheme,
  };
}

export function parseInviteUrl(raw: string): InviteTarget | null {
  const normalized = normalizeUrl(raw);
  if (!normalized) return null;
  if (normalized.path !== "invite") return null;

  const ref = normalized.params.get("ref");
  if (!ref || !BASTYON_ADDRESS_RE.test(ref)) return null;

  return { address: ref };
}

export function parseJoinUrl(raw: string): JoinTarget | null {
  const normalized = normalizeUrl(raw);
  if (!normalized) return null;
  if (normalized.path !== "join") return null;

  const room = normalized.params.get("room");
  if (!room || !MATRIX_ROOM_ID_RE.test(room)) return null;

  return { roomId: room };
}

export function parseDeepLink(raw: string): DeepLinkTarget | null {
  const invite = parseInviteUrl(raw);
  if (invite) return { kind: "invite", ...invite };

  const join = parseJoinUrl(raw);
  if (join) return { kind: "join", ...join };

  return null;
}
