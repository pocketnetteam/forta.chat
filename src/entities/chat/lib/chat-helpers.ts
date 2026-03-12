/**
 * Pure helper functions extracted from chat-store for testability.
 * These handle the critical conversions between Matrix IDs and Bastyon addresses,
 * file info parsing, and message type detection.
 */
import { getmatrixid, hexDecode } from "@/shared/lib/matrix/functions";
import type { FileInfo } from "../model/types";
import { MessageType } from "../model/types";

/** Convert a Matrix user ID to a raw Bastyon address.
 *  Matrix username = hexEncode(bastyonAddress), so we need hexDecode after getmatrixid.
 *
 *  Example: "@5050624e714377...3259753a:server" → "PPbNqCwe...2yYu"
 */
export function matrixIdToAddress(matrixUserId: string): string {
  return hexDecode(getmatrixid(matrixUserId));
}

/** Determine MessageType from MIME type string */
export function messageTypeFromMime(mime: string): MessageType {
  if (!mime) return MessageType.file;
  if (mime.startsWith("image/")) return MessageType.image;
  if (mime.startsWith("video/")) return MessageType.video;
  if (mime.startsWith("audio/")) return MessageType.audio;
  return MessageType.file;
}

/** Parse file metadata from raw event content.
 *  m.file events: body is JSON string with {name, type, size, url, secrets}
 *                 matrix-client.ts already parses it into content.pbody
 *  m.image events: info contains {w, h, secrets, url, ...} */
export function parseFileInfo(content: Record<string, unknown>, msgtype: string): FileInfo | undefined {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pbody = content.pbody as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const info = content.info as any;

  if (msgtype === "m.file" && pbody) {
    return {
      name: pbody.name ?? "file",
      type: (pbody.type ?? "").replace("encrypted/", ""),
      size: pbody.size ?? 0,
      url: pbody.url ?? "",
      secrets: pbody.secrets ? {
        block: pbody.secrets.block,
        keys: pbody.secrets.keys,
        v: pbody.secrets.v ?? pbody.secrets.version ?? 1,
      } : undefined,
    };
  }

  if (msgtype === "m.image" && info) {
    return {
      name: (content.body as string) ?? "image",
      type: info.mimetype ?? "image/jpeg",
      size: info.size ?? 0,
      url: info.url ?? (content.url as string) ?? "",
      w: info.w,
      h: info.h,
      caption: info.caption ?? undefined,
      captionAbove: info.captionAbove ?? undefined,
      secrets: info.secrets ? {
        block: info.secrets.block,
        keys: info.secrets.keys,
        v: info.secrets.v ?? info.secrets.version ?? 1,
      } : undefined,
    };
  }

  if (msgtype === "m.audio" && info) {
    return {
      name: (content.body as string) ?? "Audio",
      type: info.mimetype ?? "audio/mpeg",
      size: info.size ?? 0,
      url: info.url ?? (content.url as string) ?? "",
      duration: info.duration ? Math.round(info.duration / 1000) : undefined,
      waveform: info.waveform,
      secrets: info.secrets ? {
        block: info.secrets.block,
        keys: info.secrets.keys,
        v: info.secrets.v ?? info.secrets.version ?? 1,
      } : undefined,
    };
  }

  if (msgtype === "m.video") {
    const url = info?.url ?? (content.url as string) ?? "";
    return {
      name: (content.body as string) ?? "Video",
      type: info?.mimetype ?? "video/mp4",
      size: info?.size ?? 0,
      url,
      w: info?.w,
      h: info?.h,
      duration: info?.duration ? Math.round(info.duration / 1000) : undefined,
      secrets: info?.secrets ? {
        block: info.secrets.block,
        keys: info.secrets.keys,
        v: info.secrets.v ?? info.secrets.version ?? 1,
      } : undefined,
    };
  }

  // Try parsing body as JSON for m.file without pbody
  if (msgtype === "m.file" && typeof content.body === "string") {
    try {
      const parsed = JSON.parse(content.body);
      if (parsed.url) {
        return {
          name: parsed.name ?? "file",
          type: (parsed.type ?? "").replace("encrypted/", ""),
          size: parsed.size ?? 0,
          url: parsed.url,
          secrets: parsed.secrets ? {
            block: parsed.secrets.block,
            keys: parsed.secrets.keys,
            v: parsed.secrets.v ?? parsed.secrets.version ?? 1,
          } : undefined,
        };
      }
    } catch { /* not JSON, ignore */ }
  }

  return undefined;
}

/** Replace raw @hexid:server Matrix ID patterns with decoded Bastyon addresses.
 *  Used to clean up system messages that contain un-decoded Matrix IDs. */
export function cleanMatrixIds(text: string): string {
  return text.replace(/@([a-f0-9]{20,}):([^\s]+)/gi, (_match, hexPart: string) => {
    const addr = hexDecode(hexPart);
    // Only use decoded if it's a valid alphanumeric Base58 address (not garbage)
    if (addr !== hexPart && /^[A-Za-z0-9]+$/.test(addr)) return addr;
    return hexPart.length > 16 ? hexPart.slice(0, 8) + "\u2026" : hexPart;
  });
}

/** Resolve a system message template using a name-resolver function.
 *  Replaces {sender} and {target} placeholders with resolved display names. */
export function resolveSystemText(
  template: string,
  senderAddr: string,
  targetAddr: string | undefined,
  resolveName: (addr: string) => string,
): string {
  let result = template.replace("{sender}", resolveName(senderAddr));
  if (targetAddr) {
    result = result.replace("{target}", resolveName(targetAddr));
  }
  return result;
}

/** Check if a name looks like an unresolved hash/hex ID — not human-readable.
 *  Used to decide when to show a skeleton placeholder instead of a raw ID. */
export function isUnresolvedName(name: string): boolean {
  if (!name || name.length < 2) return true;
  if (/^#?[a-f0-9]{16,}$/i.test(name)) return true; // hex hash or #hex alias
  if (/^[a-f0-9]{8}\u2026/i.test(name)) return true; // truncated hex (8chars…)
  if (/^@[a-f0-9]{20,}:/i.test(name)) return true; // raw Matrix ID @hexid:server
  if (/^![a-zA-Z0-9]+:/i.test(name)) return true; // Matrix room ID !abc:server
  return false;
}

/** Check if a string looks like a proper human-readable name (not a hash, hex ID, or raw address) */
export function looksLikeProperName(name: string, rawAddress?: string): boolean {
  if (!name || name.length < 2) return false;
  if (name.startsWith("#") || name.startsWith("!") || name.startsWith("@")) return false;
  if (/^[a-f0-9]+$/i.test(name)) return false; // hex string
  if (rawAddress && name === rawAddress) return false; // same as raw Bastyon address
  return true;
}
