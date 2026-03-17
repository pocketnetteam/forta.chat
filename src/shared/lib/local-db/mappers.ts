import type { LocalMessage, LocalMessageStatus } from "./schema";
import type { Message } from "@/entities/chat/model/types";
import { MessageStatus } from "@/entities/chat/model/types";

/**
 * Convert a LocalMessage (Dexie row) to a Message (UI type).
 * Used by liveQuery consumers so components don't know about LocalMessage.
 */
export function localToMessage(local: LocalMessage): Message & { _key?: string } {
  const isDeleted = local.deleted || local.softDeleted;
  return {
    id: local.eventId ?? local.clientId,
    // Stable key for Vue :key binding — clientId never changes,
    // unlike id which flips from clientId to eventId after confirmSent.
    _key: local.clientId,
    roomId: local.roomId,
    senderId: local.senderId,
    content: isDeleted ? "" : local.content,
    timestamp: local.timestamp,
    status: localStatusToMessageStatus(local.status),
    type: local.type,
    fileInfo: isDeleted ? undefined : local.fileInfo,
    replyTo: isDeleted ? undefined : local.replyTo,
    reactions: isDeleted ? undefined : local.reactions,
    edited: local.edited,
    forwardedFrom: isDeleted ? undefined : local.forwardedFrom,
    callInfo: local.callInfo,
    pollInfo: isDeleted ? undefined : local.pollInfo,
    transferInfo: isDeleted ? undefined : local.transferInfo,
    linkPreview: isDeleted ? undefined : local.linkPreview,
    deleted: isDeleted,
    systemMeta: local.systemMeta,
  };
}

/** Map LocalMessage[] to Message[] (preserves order) */
export function localToMessages(locals: LocalMessage[]): Message[] {
  return locals.map(localToMessage);
}

function localStatusToMessageStatus(status: LocalMessageStatus): MessageStatus {
  switch (status) {
    case "pending":
    case "syncing":
      return MessageStatus.sending;
    case "synced":
      return MessageStatus.sent;
    case "failed":
      return MessageStatus.failed;
    case "delivered":
      return MessageStatus.delivered;
    case "read":
      return MessageStatus.read;
  }
}

/** Map MessageStatus to LocalMessageStatus (for optimistic writes) */
export function messageStatusToLocal(status: MessageStatus): LocalMessageStatus {
  switch (status) {
    case MessageStatus.sending:
      return "pending";
    case MessageStatus.sent:
      return "synced";
    case MessageStatus.failed:
      return "failed";
    case MessageStatus.delivered:
      return "delivered";
    case MessageStatus.read:
      return "read";
  }
}
