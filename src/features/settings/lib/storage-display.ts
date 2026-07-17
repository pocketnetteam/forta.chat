/**
 * Display-name helpers for the Settings → Storage screen.
 *
 * Forta's media pipeline stamps generic filenames on outbound blobs
 * (`image.png`, `audio.webm`, `video.mp4`, etc.) so the raw `fileInfo.name`
 * tells the user nothing useful. These helpers map a cache entry to a
 * human label like "Фото" / "Голосовое сообщение" / "Видеокружок" while
 * preserving the original name for documents where it carries real intent.
 */

import type { MediaCacheCategory, MediaCacheIndexEntry } from "@/shared/lib/media-cache";
import type { TranslationKey } from "@/shared/lib/i18n";

/** Filenames the upload pipeline auto-generates and which therefore carry
 *  zero user intent. Treat as "no name" so the friendly label kicks in. */
const GENERIC_FILENAMES = new Set([
  "image", "image.png", "image.jpg", "image.jpeg", "image.webp", "image.gif",
  "video", "video.mp4", "video.webm", "video.mov",
  "audio", "audio.webm", "audio.ogg", "audio.mp3", "audio.wav",
  "file",
  "untitled",
]);

function isGenericName(name: string | undefined): boolean {
  if (!name) return true;
  return GENERIC_FILENAMES.has(name.toLowerCase());
}

/** Resolve the i18n key for the friendly label of a cache entry. The
 *  caller passes the result through `t()` so the string is localised. */
export function displayLabelKey(entry: MediaCacheIndexEntry): TranslationKey {
  const category: MediaCacheCategory = entry.category ?? "file";
  const top = entry.mime.split("/")[0]?.toLowerCase() ?? "";

  if (category === "voice") return "storage.kind.voice";
  if (category === "media") {
    if (top === "video") return "storage.kind.video";
    if (top === "image") return "storage.kind.photo";
    return "storage.kind.media";
  }
  // category === "file"
  if (top === "image") return "storage.kind.photo";
  if (top === "video") return "storage.kind.video";
  if (top === "audio") return "storage.kind.audio";
  return "storage.kind.file";
}

/** Build the user-facing primary label for a cache entry row.
 *
 *  - For voice notes: always the friendly "Голосовое сообщение" label,
 *    regardless of the raw filename (which is always `audio.webm`).
 *  - For media: if the original name is generic (`image.png` / `video.mp4`),
 *    use the friendly label; otherwise the original name carries intent
 *    (e.g. user-renamed photo) and we trust it.
 *  - For files: same rule — generic = friendly label, custom = trust.
 *
 *  Returns either a localised string (when `t` is provided) or the i18n
 *  key the caller can render at the template level. Both modes exist
 *  because the Vue template uses `t()` directly while imperative code
 *  (like the search/grouping logic) wants a finished string. */
export function displayName(
  entry: MediaCacheIndexEntry,
  t: (key: TranslationKey, params?: Record<string, string | number>) => string,
): string {
  if (isGenericName(entry.fileName) || entry.category === "voice") {
    return t(displayLabelKey(entry));
  }
  return entry.fileName!;
}
