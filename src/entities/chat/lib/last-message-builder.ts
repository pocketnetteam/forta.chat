import type { LocalRoom } from "@/shared/lib/local-db";
import { deriveOutboundStatus } from "@/shared/lib/local-db";
import type { Message } from "../model/types";
import { MessageType } from "../model/types";

/** Resolve the effective preview body — prefer decrypted-cache value over
 *  raw "[encrypted]" / "m.bad.encrypted" / "** Unable to decrypt" placeholders. */
export function resolveLastMessagePreview(
  rawPreview: string | undefined,
  decryptedPreview?: string,
): string | undefined {
  if (rawPreview == null) return undefined;
  const isEncryptedPlaceholder = rawPreview === "[encrypted]"
    || rawPreview === "m.bad.encrypted"
    || rawPreview.startsWith("** Unable to decrypt");
  if (isEncryptedPlaceholder && decryptedPreview) return decryptedPreview;
  return rawPreview;
}

/** Single source of truth: build `ChatRoom.lastMessage` from a Dexie LocalRoom.
 *  Always invokes `deriveOutboundStatus` so the rendered status reflects the
 *  current `lastMessageLocalStatus` + outbound read watermark — never a stale
 *  snapshot frozen at first build.
 *
 *  Pass `decryptedPreview` to override "[encrypted]" placeholders with the
 *  decrypted body (sourced from `decryptedPreviewCache`).
 *
 *  Returns `undefined` when the room has no preview yet (fresh join, no history). */
export function buildLastMessage(
  lr: LocalRoom,
  decryptedPreview?: string,
): Message | undefined {
  const effectivePreview = resolveLastMessagePreview(lr.lastMessagePreview, decryptedPreview);
  if (effectivePreview == null) return undefined;

  const ts = lr.lastMessageTimestamp ?? 0;
  return {
    id: lr.lastMessageEventId ?? "",
    roomId: lr.id,
    senderId: lr.lastMessageSenderId ?? "",
    content: effectivePreview,
    timestamp: ts,
    status: deriveOutboundStatus(
      lr.lastMessageLocalStatus ?? "synced",
      ts,
      lr.lastReadOutboundTs ?? 0,
    ),
    type: lr.lastMessageType ?? MessageType.text,
    decryptionStatus: lr.lastMessageDecryptionStatus,
    callInfo: lr.lastMessageCallInfo,
    systemMeta: lr.lastMessageSystemMeta,
  };
}

/** Build `ChatRoom.lastMessage` from an in-memory `Message` while overriding
 *  the status with the Dexie-derived value when a `LocalRoom` is available.
 *
 *  **Single-source semantic**: Dexie owns transport status. When `lr` is
 *  provided, the returned `status` ALWAYS comes from
 *  `deriveOutboundStatus(lr.lastMessageLocalStatus, …)` — the caller's
 *  `msg.status` is overridden. This is intentional: in-memory mutation paths
 *  (`addMessage`, `updateMessageStatus`, `setMessages`, …) and Dexie observer
 *  paths (`mapLocalRoomToChatRoom`) must agree on transport state, otherwise
 *  the sidebar flickers as the two writers race.
 *
 *  Edge case: when an event arrives ahead of Dexie (e.g. fresh `read` receipt
 *  before `lastReadOutboundTs` is committed), the helper temporarily downgrades
 *  the status until Dexie catches up — typically within 1-2 ticks. This is
 *  preferred over the previous behaviour where in-memory state diverged
 *  permanently from Dexie until a full refresh.
 *
 *  When `lr` is absent, returns the message unchanged (caller has more info). */
export function lastMessageFromMessage(msg: Message, lr?: LocalRoom): Message {
  if (!lr) return msg;
  const derivedStatus = deriveOutboundStatus(
    lr.lastMessageLocalStatus ?? "synced",
    lr.lastMessageTimestamp ?? msg.timestamp,
    lr.lastReadOutboundTs ?? 0,
  );
  if (derivedStatus === msg.status) return msg;
  return { ...msg, status: derivedStatus };
}
