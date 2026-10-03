import { getmatrixid, hexDecode } from "./functions";

/** A Bastyon address after hexDecode — anything else is a mangled id. */
const ADDRESS_RE = /^[A-Za-z0-9]+$/;
/** Pcrypto keys its per-recipient payloads by hex-encoded address. */
const HEX_ID_RE = /^[0-9a-f]+$/i;

function decodeBase64(text: string): string | null {
  try {
    return globalThis.atob(text);
  } catch {
    return null;
  }
}

/** The Base64 "secrets" blob of a Pcrypto event: the text body of a 1:1
 *  message, or the per-recipient keys of a file / common-key event.
 *  Group messages (content.hash) carry no recipients — but a common-key
 *  event carries a hash too, so it is read first. */
function secretsBlob(raw: Record<string, unknown>): string | null {
  const content = raw.content as Record<string, unknown> | undefined;
  if (!content) return null;
  if (raw.type === "m.room.encryption") return typeof content.keys === "string" ? content.keys : null;
  if (content.hash) return null;
  const info = content.info as { secrets?: { keys?: unknown } } | undefined;
  const pbody = content.pbody as { secrets?: { keys?: unknown } } | undefined;
  const fileKeys = info?.secrets?.keys ?? pbody?.secrets?.keys;
  if (typeof fileKeys === "string") return fileKeys;
  if (content.msgtype === "m.encrypted" && typeof content.body === "string") return content.body;
  return null;
}

/**
 * Hex ids of the users a Pcrypto event was encrypted for. They name the
 * participants even when the room's member list is incomplete (lazy-loaded
 * members): a 1:1 message carries the peer, including in one's own messages.
 * Returns [] for anything that is not a parseable Pcrypto payload.
 */
export function pcryptoRecipientHexIds(raw: Record<string, unknown> | null | undefined): string[] {
  if (!raw) return [];
  const blob = secretsBlob(raw);
  if (!blob) return [];
  const decoded = decodeBase64(blob);
  if (!decoded?.startsWith("{")) return [];
  try {
    const body = JSON.parse(decoded) as Record<string, unknown>;
    return Object.keys(body).filter((id) => HEX_ID_RE.test(id));
  } catch {
    return [];
  }
}

/** Bastyon address of a hex id or Matrix user id, or null if it isn't one. */
export function addressFromMatrixId(id: string | null | undefined): string | null {
  if (!id) return null;
  const hex = getmatrixid(id);
  if (!hex || !HEX_ID_RE.test(hex)) return null;
  const addr = hexDecode(hex);
  return ADDRESS_RE.test(addr) ? addr : null;
}

/**
 * Addresses whose keys decrypting these events needs: each sender plus every
 * Pcrypto recipient. `exclude` (the own address) is left out. Feeds one
 * batched key load ahead of a decrypt loop, so the loop's per-room key
 * requests find the keys in SDK memory instead of each sending its own.
 */
export function eventKeyAddresses(
  events: readonly (Record<string, unknown> | null | undefined)[],
  exclude?: string | null,
): string[] {
  const out = new Set<string>();
  for (const raw of events) {
    if (!raw) continue;
    const sender = addressFromMatrixId(raw.sender as string | undefined);
    if (sender) out.add(sender);
    for (const hexId of pcryptoRecipientHexIds(raw)) {
      const addr = addressFromMatrixId(hexId);
      if (addr) out.add(addr);
    }
  }
  if (exclude) out.delete(exclude);
  return [...out];
}
