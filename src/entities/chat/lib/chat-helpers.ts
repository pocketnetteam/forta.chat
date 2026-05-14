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
 *  Validates the decoded result contains only printable alphanumeric characters.
 *
 *  Example: "@5050624e714377...3259753a:server" → "PPbNqCwe...2yYu"
 */
export function matrixIdToAddress(matrixUserId: string): string {
  const hexPart = getmatrixid(matrixUserId);
  const decoded = hexDecode(hexPart);
  // Reject strings with non-printable or non-alphanumeric characters
  if (/^[A-Za-z0-9]+$/.test(decoded)) return decoded;
  // Return raw hex part as fallback — display layer will sanitize
  return hexPart;
}

/** Normalize MIME: fallback to application/octet-stream for empty/unknown types */
export function normalizeMime(mime: string | undefined): string {
  return mime && mime.includes("/") ? mime : "application/octet-stream";
}

/** Determine MessageType from MIME type string */
export function messageTypeFromMime(mime: string): MessageType {
  const m = normalizeMime(mime);
  if (m.startsWith("image/")) return MessageType.image;
  if (m.startsWith("video/")) return MessageType.video;
  if (m.startsWith("audio/")) return MessageType.audio;
  return MessageType.file;
}

/** Map MIME → file extension (used when body has no extension). */
const MIME_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/heic": "heic",
  "image/heif": "heif",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
  "video/3gpp": "3gp",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/mp4": "m4a",
  "audio/ogg": "ogg",
  "audio/wav": "wav",
  "audio/webm": "webm",
  "audio/aac": "aac",
};

/** Append extension from mime if filename doesn't already have one.
 *  - alpha-first regex avoids treating "track.2024" or "v1.0" as already-
 *    extensioned (saves "holiday.2024" as "holiday.2024.jpg" instead of
 *    losing the .jpg)
 *  - strips MIME parameters ("image/jpeg; charset=binary" → "image/jpeg") */
function ensureExt(name: string, mime: string): string {
  if (/\.[a-zA-Z][a-zA-Z0-9]{1,4}$/.test(name)) return name;
  const cleanMime = mime.split(";")[0].trim().toLowerCase().replace(/^encrypted\//, "");
  const ext = MIME_EXT[cleanMime] ?? "bin";
  return `${name}.${ext}`;
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
  // Canonical Matrix encrypted attachments (Element, Cinny, FluffyChat, …)
  // carry `mxc://` url under `content.file.url` alongside { iv, key, hashes }.
  // Bastyon's own pipeline duplicates the url into pbody/info/content.url,
  // but messages forwarded from other clients omit those copies — without a
  // fallback the download path throws "No file URL" (Session 57, bugs #740,
  // #739, #719, #567).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const encryptedFile = content.file as any;
  const encryptedUrl: string | undefined = typeof encryptedFile?.url === "string" ? encryptedFile.url : undefined;

  if (msgtype === "m.file" && pbody) {
    return {
      name: pbody.name ?? "file",
      type: (pbody.type ?? "").replace("encrypted/", ""),
      size: pbody.size ?? 0,
      url: pbody.url ?? encryptedUrl ?? "",
      secrets: pbody.secrets ? {
        block: pbody.secrets.block,
        keys: pbody.secrets.keys,
        v: pbody.secrets.v ?? pbody.secrets.version ?? 1,
      } : undefined,
    };
  }

  if (msgtype === "m.image" && info) {
    return {
      name: ensureExt((content.body as string) || "image", info.mimetype ?? "image/jpeg"),
      type: info.mimetype ?? "image/jpeg",
      size: info.size ?? 0,
      url: info.url ?? encryptedUrl ?? (content.url as string) ?? "",
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
    // Waveform arrives as integers 0-1024 (MSC3245), normalize to 0-1 floats
    const rawWaveform = info.waveform as number[] | undefined;
    const normalizedWaveform = rawWaveform?.length
      ? rawWaveform.map((v: number) => v > 1 ? v / 1024 : v)
      : undefined;

    return {
      name: ensureExt((content.body as string) || "Audio", info.mimetype ?? "audio/mpeg"),
      type: info.mimetype ?? "audio/mpeg",
      size: info.size ?? 0,
      url: info.url ?? encryptedUrl ?? (content.url as string) ?? "",
      duration: typeof info.duration === "number" && info.duration > 0
        ? Math.round(info.duration / 1000)
        : undefined,
      waveform: normalizedWaveform,
      secrets: info.secrets ? {
        block: info.secrets.block,
        keys: info.secrets.keys,
        v: info.secrets.v ?? info.secrets.version ?? 1,
      } : undefined,
    };
  }

  if (msgtype === "m.video") {
    const url = info?.url ?? encryptedUrl ?? (content.url as string) ?? "";
    return {
      name: ensureExt((content.body as string) || "Video", info?.mimetype ?? "video/mp4"),
      type: info?.mimetype ?? "video/mp4",
      size: info?.size ?? 0,
      url,
      w: info?.w,
      h: info?.h,
      duration: info?.duration ? Math.round(info.duration / 1000) : undefined,
      videoNote: info?.videoNote === true ? true : undefined,
      thumbnailUrl: info?.thumbnailUrl ?? undefined,
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

  // Canonical Matrix encrypted m.file from non-Bastyon clients: no pbody,
  // body is a plain filename string. Construct FileInfo directly from
  // content.file.url + info{mimetype,size}.
  if (msgtype === "m.file" && encryptedUrl) {
    const mime = (info?.mimetype as string | undefined) ?? "application/octet-stream";
    return {
      name: ensureExt((content.body as string) || "file", mime),
      type: mime.replace("encrypted/", ""),
      size: info?.size ?? 0,
      url: encryptedUrl,
      // Secrets follow Matrix EncryptedFile shape: { url, key, iv, hashes, v }.
      // We do not surface them here because the bastyon-chat crypto pipeline
      // reads its own pbody.secrets shape; canonical-Matrix decryption is
      // handled by matrix-js-sdk before parseFileInfo runs.
    };
  }

  return undefined;
}

/** Replace raw Matrix IDs and bare hex-encoded addresses with decoded Bastyon addresses.
 *  Handles both @hexid:server patterns and standalone hex strings (40+ chars). */
export function cleanMatrixIds(text: string): string {
  // 1. Replace @hexid:server patterns
  let result = text.replace(/@([a-f0-9]{20,}):([^\s]+)/gi, (_match, hexPart: string) => {
    const addr = hexDecode(hexPart);
    if (addr !== hexPart && /^[A-Za-z0-9]+$/.test(addr)) return addr;
    return hexPart.length > 16 ? hexPart.slice(0, 8) + "\u2026" : hexPart;
  });
  // 2. Replace bare hex strings (40+ chars) — hex-encoded Bastyon addresses in system messages
  result = result.replace(/\b([a-f0-9]{40,})\b/gi, (_match, hexPart: string) => {
    const addr = hexDecode(hexPart);
    if (addr !== hexPart && /^[A-Za-z0-9]+$/.test(addr)) return addr;
    return hexPart.slice(0, 8) + "\u2026";
  });
  return result;
}

/** Resolve a system message i18n key using a name-resolver and translation function.
 *  If the template is an i18n key (starts with "system."), uses t() for localization.
 *  Falls back to legacy template interpolation for old messages stored with English templates. */
export function resolveSystemText(
  template: string,
  senderAddr: string,
  targetAddr: string | undefined,
  resolveName: (addr: string) => string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  t?: (key: any, params?: Record<string, string | number>) => string,
  extra?: Record<string, string>,
): string {
  const sender = resolveName(senderAddr);
  const target = targetAddr ? resolveName(targetAddr) : undefined;

  // New path: i18n key (e.g. "system.joined")
  if (t && template.startsWith("system.")) {
    const params: Record<string, string> = { sender, ...extra };
    if (target) params.target = target;
    return t(template, params);
  }

  // Legacy path: old messages stored with English template strings
  let result = template.replace("{sender}", sender);
  if (target) {
    result = result.replace("{target}", target);
  }
  return result;
}

/** Check if a name looks like an unresolved hash/hex ID — not human-readable.
 *  Used to decide when to show a skeleton placeholder instead of a raw ID. */
export function isUnresolvedName(name: string): boolean {

  if (!name || name.length < 2) return true;
  if (/^#?[a-f0-9]{16,}$/i.test(name)) return true; // hex hash or #hex alias
  if (/^#[a-f0-9]{6,}(:.+)?$/i.test(name)) return true; // hex-encoded room alias #hex or #hex:server
  if (/^#[a-f0-9]{6,}\u2026/i.test(name)) return true; // truncated hex with # prefix (#aefd725b…)
  /*if (/^[a-f0-9]{8}\u2026/i.test(name)) return true; // truncated hex (8chars…)
  if (/^[A-Za-z0-9]{8}\u2026/i.test(name)) return true; // truncated address (8chars…)*/
  if (/^@[a-f0-9]{20,}:/i.test(name)) return true; // raw Matrix ID @hexid:server
  if (/^![a-zA-Z0-9]+:/i.test(name)) return true; // Matrix room ID !abc:server
  //if (/^[A-Za-z0-9]{20,}$/.test(name)) return true; // raw Bastyon address (base58, 20+ chars)
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
