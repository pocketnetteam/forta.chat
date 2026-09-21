/**
 * Content of an encrypted edit (m.replace) event.
 *
 * Matches bastyon-chat (components/chat/input/index.js): the edit carries the
 * WHOLE `encryptEvent()` result at the top level plus `m.relates_to`. Readers
 * decrypt the outer content, and group ciphertexts are routed by `hash`
 * (decryptEvent → decryptEventGroup) — copying only body/block/version drops
 * `hash`, so every group edit fell into the 1:1 path and rendered as
 * "[encrypted]".
 *
 * `m.new_content` repeats the ciphertext (never the plaintext — that would
 * ship the edited text to the server unencrypted) so the Matrix SDK's
 * replacement aggregation still sees an encrypted payload.
 */
export function buildEncryptedEditContent(
  encrypted: Record<string, unknown>,
  targetEventId: string,
): Record<string, unknown> {
  return {
    ...encrypted,
    "m.new_content": { ...encrypted },
    "m.relates_to": {
      rel_type: "m.replace",
      event_id: targetEventId,
    },
  };
}
