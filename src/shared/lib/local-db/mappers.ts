import type { LocalMessage, LocalMessageStatus } from "./schema";
import type { Message } from "@/entities/chat/model/types";
import { MessageStatus } from "@/entities/chat/model/types";

/**
 * Convert a LocalMessage (Dexie row) to a Message (UI type).
 * Used by liveQuery consumers so components don't know about LocalMessage.
 */
export function localToMessage(local: LocalMessage): Message {
  return {
    id: local.eventId ?? local.clientId,
    roomId: local.roomId,
    senderId: local.senderId,
    content: local.content,
    timestamp: local.timestamp,
    status: localStatusToMessageStatus(local.status),
    type: local.type,
    fileInfo: local.fileInfo,
    replyTo: local.replyTo,
    reactions: local.reactions,
    edited: local.edited,
    forwardedFrom: local.forwardedFrom,
    callInfo: local.callInfo,
    pollInfo: local.pollInfo,
    transferInfo: local.transferInfo,
    linkPreview: local.linkPreview,
    deleted: local.deleted ?? local.softDeleted,
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
