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
    callLinkInfo: isDeleted ? undefined : local.callLinkInfo,
    linkPreview: isDeleted ? undefined : local.linkPreview,
    deleted: isDeleted,
    systemMeta: local.systemMeta,
    uploadProgress: local.uploadProgress,
    decryptionStatus: (local.decryptionStatus === "pending" || local.decryptionStatus === "failed")
      ? local.decryptionStatus : undefined,
  };
}

/** Map LocalMessage[] to Message[] (preserves order).
 *  Fault-tolerant: if a single LocalMessage fails to convert (corrupt data,
 *  missing fields), it is replaced with a placeholder instead of crashing
 *  the entire computed. This prevents one bad Dexie row from causing
 *  a black screen / infinite loading. */
export function localToMessages(locals: LocalMessage[], outboundWatermark?: number, myAddress?: string): Message[] {
  return locals.map(l => {
    try {
      return localToMessage(l, outboundWatermark, myAddress);
    } catch (err) {
      console.error("[localToMessages] Failed to convert LocalMessage, using placeholder:", l.eventId ?? l.clientId, err);
      return createCorruptedPlaceholder(l);
    }
  });
}

/** Create a safe placeholder Message for a LocalMessage that failed conversion.
 *  Ensures the pipeline never crashes — the user sees an error indicator
 *  instead of a black screen. */
function createCorruptedPlaceholder(local: LocalMessage): Message {
  return {
    id: local.eventId ?? local.clientId ?? `corrupt_${local.localId ?? Date.now()}`,
    _key: local.clientId ?? local.eventId ?? `corrupt_${local.localId ?? Date.now()}`,
    roomId: local.roomId ?? "",
    senderId: local.senderId ?? "",
    content: "[message error]",
    timestamp: local.timestamp ?? Date.now(),
    status: MessageStatus.sent,
    type: local.type ?? ("text" as any),
    deleted: false,
  };
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
    case "cancelled":
      return MessageStatus.cancelled;
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
  if (localStatus === "cancelled") return MessageStatus.cancelled;

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
    case MessageStatus.cancelled:
      return "cancelled";
    case MessageStatus.delivered:
      return "delivered";
    case MessageStatus.read:
      return "read";
  }
}
