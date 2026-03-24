/** Raw encryption marker strings that must never reach the UI. */
const ENCRYPTED_MARKERS = new Set([
  "[encrypted]",
  "m.bad.encrypted",
  "Unable to decrypt",
  "** Unable to decrypt **",
  "Waiting for encryption keys",
]);

/**
 * Returns true if the content is an unresolved encryption placeholder
 * that should NOT be displayed to the user.
 */
export function isEncryptedPlaceholder(content: string | undefined | null): boolean {
  if (!content) return false;
  return ENCRYPTED_MARKERS.has(content) || content.startsWith("** Unable to decrypt");
}
