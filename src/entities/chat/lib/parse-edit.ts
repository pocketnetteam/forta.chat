/**
 * Resolve the plaintext body of an incoming edit event (m.replace relation).
 *
 * Priority:
 *   1. If the event (or its m.new_content) is encrypted, decrypt the raw
 *      event and use the decrypted `body`.
 *   2. Otherwise, take `m.new_content.body` (canonical new version).
 *   3. Otherwise, fall back to the outer `body` (legacy clients that only
 *      set `body` with the `* ` fallback prefix).
 *
 * Security guarantee — fixes bug #193 / #222:
 *   On decryption failure we return the supplied `encryptedPlaceholder`,
 *   NEVER the raw ciphertext. Previously the fallback read `newContent.body`
 *   directly, which in encrypted rooms is a ciphertext blob — surfacing it
 *   as the visible message text made groups display "unreadable garbage".
 */
export interface ParseEditBodyInput {
  raw: Record<string, unknown>;
  content: Record<string, unknown>;
  newContent: Record<string, unknown> | undefined;
  decryptEvent: (raw: Record<string, unknown>) => Promise<{ body: string; msgtype: string }>;
  encryptedPlaceholder: string;
}

export async function parseEditBody({
  raw,
  content,
  newContent,
  decryptEvent,
  encryptedPlaceholder,
}: ParseEditBodyInput): Promise<string> {
  const isEncrypted =
    newContent?.msgtype === "m.encrypted" || content.msgtype === "m.encrypted";

  if (isEncrypted) {
    try {
      const decrypted = await decryptEvent(withRecoveredGroupHash(raw, content, newContent));
      return decrypted.body;
    } catch {
      return encryptedPlaceholder;
    }
  }

  return (newContent?.body as string) ?? (content.body as string) ?? "";
}

/** Group edits sent by older Forta builds copied body/block/version to the
 *  outer content but not `hash`, so decryptEvent routed them to the 1:1 path
 *  and they could never be read. Their `m.new_content` holds the full
 *  encryptEvent() result, hash included — lift it back onto the outer content. */
function withRecoveredGroupHash(
  raw: Record<string, unknown>,
  content: Record<string, unknown>,
  newContent: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (content.hash || newContent?.msgtype !== "m.encrypted" || !newContent.hash) return raw;
  return { ...raw, content: { ...content, hash: newContent.hash } };
}
