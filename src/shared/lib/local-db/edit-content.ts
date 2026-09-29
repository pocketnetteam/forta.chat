/**
 * The content of an `m.replace` event.
 *
 * In an encrypted room the outer content is what every reader decrypts
 * (`entities/chat/lib/parse-edit.ts`), so it has to carry the whole encrypted event.
 * It used to take `body`, `block` and `version` only. A group room encrypts with the
 * room's common key and names it by `hash`; without `hash` the reader took the edit for
 * a one-to-one event, failed, and showed «[encrypted]» to everyone, the author included
 * (forta-bugs #1300, #1320 and nine more, September 2026). One-to-one rooms have no
 * `hash`, which is why only groups broke.
 */
export function buildEditContent(
  eventId: string,
  newContent: string,
  encrypted: Record<string, unknown> | null,
): Record<string, unknown> {
  const relatesTo = { rel_type: "m.replace", event_id: eventId };
  if (encrypted) {
    return { ...encrypted, msgtype: "m.encrypted", "m.new_content": encrypted, "m.relates_to": relatesTo };
  }
  return {
    msgtype: "m.text",
    body: `* ${newContent}`,
    "m.new_content": { msgtype: "m.text", body: newContent },
    "m.relates_to": relatesTo,
  };
}
