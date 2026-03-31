import type { LocalMessage, LocalMessageStatus } from "./schema";
import type { Message } from "@/entities/chat/model/types";
import { MessageStatus } from "@/entities/chat/model/types";

/**
 * Convert a LocalMessage (Dexie row) to a Message (UI type).
 * Used by liveQuery consumers so components don't know about LocalMessage.
 */
export function localToMessage(
  local: LocalMessage,
  outboundWatermark?: number,
  myAddress?: string,
): Message {
  const isDeleted = local.deleted || local.softDeleted;
  const isOwnMessage = myAddress && local.senderId === myAddress;
  const status = (outboundWatermark !== undefined && isOwnMessage)
    ? deriveOutboundStatus(local.status, local.timestamp, outboundWatermark)
    : localStatusToMessageStatus(local.status);
  return {
    id: local.eventId ?? local.clientId,
    // Stable key for Vue :key binding — clientId never changes,
    // unlike id which flips from clientId to eventId after confirmSent.
    _key: local.clientId,
    roomId: local.roomId,
    senderId: local.senderId,
    content: isDeleted ? "" : local.content,
    timestamp: local.timestamp,
    status,
    type: local.type,
    fileInfo: isDeleted ? undefined : (local.fileInfo ? {
      ...local.fileInfo,
      // Use local blob URL for instant preview during upload, fall back to server URL
      url: local.localBlobUrl || local.fileInfo.url,
    } : undefined),
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
    uploadProgress: local.uploadProgress,
    decryptionStatus: (local.decryptionStatus === "pending" || local.decryptionStatus === "failed")
      ? local.decryptionStatus : undefined,
  };
}

/** Map LocalMessage[] to Message[] (preserves order) */
export function localToMessages(locals: LocalMessage[], outboundWatermark?: number, myAddress?: string): Message[] {
  return locals.map(l => localToMessage(l, outboundWatermark, myAddress));
}

export function localStatusToMessageStatus(status: LocalMessageStatus): MessageStatus {
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

/**
 * Derive the display status for an outbound (own) message
 * by comparing its timestamp against the room's outbound read watermark.
 *
 * This replaces per-message "read"/"delivered" status with a pure derivation
 * from the room-level watermark, ensuring Chat List and Chat Room always agree.
 */
export function deriveOutboundStatus(
  localStatus: LocalMessageStatus,
  messageTimestamp: number,
  roomLastReadOutboundTs: number,
): MessageStatus {
  // Local-only statuses take priority (not yet on server)
  if (localStatus === "pending" || localStatus === "syncing") return MessageStatus.sending;
  if (localStatus === "failed") return MessageStatus.failed;

  // Derived from watermark: if the other party read up to this timestamp → read
  if (roomLastReadOutboundTs >= messageTimestamp) return MessageStatus.read;

  // On server but not yet read
  return MessageStatus.sent;
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
