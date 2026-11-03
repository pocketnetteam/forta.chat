/**
 * Removes identifiers from bug report text before it leaves the device (audit
 * S10-06). Reports land in a GitHub repository, and a Matrix ID, a Bastyon
 * address or a media link there ties the report to a person or to their
 * messages. The rules keep what triage needs: versions, call IDs, error names.
 *
 * No lookbehind: iOS 15 WebKit cannot parse it, and one such regex would stop
 * this module from loading.
 */
const RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(access_token=)[^&\s"'<>]+/gi, '$1<token>'],
  [/\bsyt_[A-Za-z0-9_]+/g, '<token>'],
  [/\bmxc:\/\/[^\s"'<>)]+/g, '<media>'],
  // Before the Matrix IDs: in an e-mail address the @ has a name before it.
  [/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '<email>'],
  [/@[^\s:@<>]+:[\w-]+(?:\.[\w-]+)*(?::\d+)?/g, '<user>'],
  [/![^\s:!<>]+:[\w-]+(?:\.[\w-]+)*(?::\d+)?/g, '<room>'],
  [/#[^\s:#<>]+:[\w-]+(?:\.[\w-]+)+/g, '<alias>'],
  [/\$[A-Za-z0-9_+/=-]{20,}(?::[\w-]+(?:\.[\w-]+)*)?/g, '<event>'],
  [/\bP[1-9A-HJ-NP-Za-km-z]{33}\b/g, '<address>'],
  // A dotted quad after "/" is a version ("Chrome/131.0.0.0"), not an address.
  [/(^|[^\w./])(?:\d{1,3}\.){3}\d{1,3}(?![\w.])/g, '$1<ip>'],
];

export function scrubPii(text: string): string {
  let out = text;
  for (const [pattern, replacement] of RULES) out = out.replace(pattern, replacement);
  return out;
}
