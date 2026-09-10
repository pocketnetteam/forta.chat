import type { ParsedMessage } from "@/shared/lib/local-db";
import type { Message } from "@/entities/chat/model/types";

/**
 * Map parsed timeline Messages to EventWriter input for the bulk
 * (scrollback / room-load / prefetch) write paths.
 *
 * `encryptedRaw` must travel with every "[encrypted]" message: EventWriter
 * derives `encryptedBody` + `decryptionStatus: "pending"` from it. Without
 * it the row used to be stored as "[encrypted]" with no ciphertext and
 * status "ok" — invisible to every recovery sweep and impossible to
 * decrypt later. `rawById` maps event_id → raw Matrix event.
 */
export function toParsedMessages(
  msgs: Message[],
  rawById: ReadonlyMap<string, Record<string, unknown>>,
): ParsedMessage[] {
  return msgs
    .filter((m) => m.id && !m.id.startsWith("msg_")) // Skip optimistic temp messages
    .map((m) => ({
      eventId: m.id,
      roomId: m.roomId,
      senderId: m.senderId,
      content: m.content,
      timestamp: m.timestamp,
      type: m.type,
      fileInfo: m.fileInfo,
      replyTo: m.replyTo,
      forwardedFrom: m.forwardedFrom,
      callInfo: m.callInfo,
      pollInfo: m.pollInfo,
      transferInfo: m.transferInfo,
      callLinkInfo: m.callLinkInfo,
      linkPreview: m.linkPreview,
      deleted: m.deleted,
      systemMeta: m.systemMeta,
      reactions: m.reactions,
      encryptedRaw: m.content === "[encrypted]" ? rawById.get(m.id) : undefined,
    }));
}
