import type { CallLinkInfo } from "@/entities/chat/model/types";

/**
 * External call-link message encoding (WEE-57).
 *
 * A call-link is shipped as a normal `m.text` message whose body is a JSON
 * envelope — exactly the trick the `_transfer` feature uses. This keeps the
 * structured payload inside the end-to-end encryption envelope and needs no
 * new Matrix event type, while the receiver reconstructs a rich card from it.
 *
 * Provider-agnostic: the envelope carries only a label and a URL.
 */

/** Cheap prefix check before attempting a JSON.parse on every text body. */
export const CALL_LINK_MARKER = '{"_callLink":true';

/** Only http(s) meeting links may be opened — a peer's encrypted message is
 *  attacker-controlled, so reject javascript:/data:/file: schemes here. */
const SAFE_URL_RE = /^https?:\/\/.+/i;

/** Serialize call-link metadata into the message body sent over Matrix. */
export function buildCallLinkBody(info: CallLinkInfo): string {
  return JSON.stringify({ _callLink: true, url: info.url, label: info.label });
}

/**
 * Parse a message body back into `CallLinkInfo`, or `null` when the body is
 * not a valid call-link envelope. Defensive: never throws, validates every
 * field (url must be http(s)) so a malformed/hostile body degrades to plain
 * text instead of rendering a broken/unsafe card.
 */
export function parseCallLinkBody(body: string): CallLinkInfo | null {
  if (!body.startsWith(CALL_LINK_MARKER)) return null;
  try {
    const raw = JSON.parse(body) as Record<string, unknown>;
    if (raw._callLink !== true) return null;
    const url = raw.url;
    const label = raw.label;
    if (typeof url !== "string" || !SAFE_URL_RE.test(url)) return null;
    return {
      url,
      label: typeof label === "string" && label.length > 0 ? label : url,
    };
  } catch {
    return null;
  }
}

/** Sidebar/preview text for a call-link message. */
export function callLinkPreview(info: Pick<CallLinkInfo, "label">): string {
  return `📞 ${info.label}`;
}
