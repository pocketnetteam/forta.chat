/**
 * Sanitize a sender-controlled file name before passing it to native
 * save APIs (Android MediaStore.insert, Capacitor Filesystem.writeFile).
 *
 * Matrix `m.file` / `m.image` events carry a `body` / `pbody.name` field
 * that the sender controls — any value can arrive here, including
 * `../`, embedded path separators, control characters, or names long
 * enough to choke the file system. On Android API 28- the legacy save
 * path uses `File(targetDir, fileName)`, which resolves `..` relative
 * to `Pictures/Forta Chat/` and writes outside the intended folder.
 *
 * This function is the single line of defence for both platforms. It:
 *  - strips path separators and control characters
 *  - drops parent-directory `..` tokens
 *  - replaces filesystem-reserved characters with `_`
 *  - trims surrounding whitespace and dots
 *  - caps total length to 200 characters while preserving extension
 *  - returns `"file"` when sanitization leaves nothing usable
 */
const MAX_LENGTH = 200;
const FALLBACK = "file";

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x1F\x7F]/g;
const PATH_SEPARATORS = /[/\\]/g;
const RESERVED_CHARS = /[<>:"|?*]/g;

export function sanitizeFileName(input: string): string {
  if (typeof input !== "string") return FALLBACK;

  // Drop control chars (incl. NUL), then replace separators and reserved
  // chars with `_` so we don't fuse adjacent tokens together (e.g.
  // `foo/bar.jpg` should not collapse into `foobar.jpg`).
  let out = input
    .replace(CONTROL_CHARS, "")
    .replace(PATH_SEPARATORS, "_")
    .replace(RESERVED_CHARS, "_");

  // Strip parent-directory tokens. Repeat until no more changes — a
  // single pass over `....` would leave `..` behind.
  let previous: string;
  do {
    previous = out;
    out = out.replace(/\.\./g, "");
  } while (out !== previous);

  // Collapse runs of `_` left behind by separator/reserved-char
  // substitution (e.g. `../../etc/passwd` → `..__..__etc_passwd` →
  // `_____etc_passwd` → `_etc_passwd`), then trim leading/trailing
  // `_` so the user sees `etc_passwd` and not `_etc_passwd`.
  out = out.replace(/_+/g, "_");

  // Trim surrounding whitespace, dots (hidden-file convention; trailing
  // dots break Windows / SMB shares), and the underscores we just
  // collapsed.
  out = out.replace(/^[\s._]+|[\s._]+$/g, "");

  if (!out) return FALLBACK;

  if (out.length <= MAX_LENGTH) return out;

  // Length cap, preserving extension when present. Cap the extension
  // itself at 16 chars to avoid pathological inputs eating the whole
  // budget.
  const dot = out.lastIndexOf(".");
  if (dot > 0 && out.length - dot <= 16) {
    const ext = out.slice(dot);
    const stem = out.slice(0, dot);
    const room = MAX_LENGTH - ext.length;
    return stem.slice(0, room) + ext;
  }
  return out.slice(0, MAX_LENGTH);
}
