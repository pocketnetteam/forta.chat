import { MessageStatus, MessageType, type Message } from "../model/types";
import { matrixIdToAddress } from "./chat-helpers";

/**
 * The call record for an invite nobody ended (`call-outcome.ts`, `isOrphanedInvite`).
 *
 * A call shows in the chat through its hangup. When the caller's client went away before
 * its SDK sent `invite_timeout`, no hangup came and the call left no trace: the callee saw
 * nothing in the chat about a call that rang. The invite then stands in for the hangup:
 * a missed call, keyed by the call id so the hangup's record replaces it if one arrives
 * (`dedupe-call-events.ts`).
 */
export function inviteCallRecord(raw: Record<string, unknown>, roomId: string): Message {
  const content = (raw.content ?? {}) as Record<string, unknown>;
  const offer = content.offer as { sdp?: unknown } | undefined;
  const isVideo = content.offer_type === "video"
    || (typeof offer?.sdp === "string" && offer.sdp.includes("m=video"));
  const sender = matrixIdToAddress(raw.sender as string);
  return {
    id: raw.event_id as string,
    roomId,
    senderId: sender,
    content: "",
    timestamp: (raw.origin_server_ts as number) ?? 0,
    status: MessageStatus.sent,
    type: MessageType.system,
    callInfo: {
      callType: isVideo ? "video" : "voice",
      missed: true,
      duration: 0,
      callId: content.call_id as string | undefined,
      fromInvite: true,
    },
    systemMeta: { template: isVideo ? "system.missedVideoCall" : "system.missedVoiceCall", senderAddr: sender },
  };
}
