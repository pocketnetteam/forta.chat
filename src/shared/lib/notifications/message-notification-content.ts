/**
 * Shared shape for a "new message" notification: who it is from and where it
 * came from.
 *
 * Users reported that a push from a group chat is indistinguishable from a
 * direct message — both used to render as `title = sender name`, so the group
 * the message belongs to was nowhere on screen. The fix follows the
 * Telegram/WhatsApp convention:
 *
 *   group chat → title = room name,   body = "Sender: text"
 *   direct chat → title = sender name, body = "text"   (unchanged)
 *
 * Kept as a pure, platform-free function so every renderer agrees:
 *   - `push-service.ts` (Android, JS replaces the native notification after
 *     the event is decrypted),
 *   - `chat-store.ts` → `web-notifier.ts` (Web / Electron banners).
 *
 * The Android cold-start path (WebView not alive) and the iOS Notification
 * Service Extension apply the same rule natively — see
 * `FortaFirebaseMessagingService.buildMessageNotification` and
 * `NotificationService.swift`.
 */
export interface MessageNotificationContent {
  title: string;
  body: string;
}

export interface MessageNotificationInput {
  /** Resolved display name of the message author; absent when unknown. */
  senderName?: string | null;
  /** Resolved room name; for direct chats this is usually the peer's name. */
  roomName?: string | null;
  /** True when the room is a group chat (Dexie `rooms.isGroup`). */
  isGroup: boolean;
  /** Already-rendered message preview (decrypted text or msgtype placeholder). */
  body: string;
  /** Last-resort title when neither sender nor room name is known. */
  fallbackTitle: string;
  /**
   * Which name titles a DIRECT chat. Group chats always use the room name.
   *
   * In a direct chat both names denote the same person, so this only decides
   * which resolution chain wins when one of them is stale. The two callers
   * disagree on which is the better source, and neither wanted its behaviour
   * changed by the group-marking work:
   *   - "room" (Web/Electron): `room.name` is the Dexie-resolved chat-list
   *     name, while `getDisplayName` falls back to a truncated address when
   *     the display-name cache is still cold.
   *   - "sender" (native push): the sender comes from the decrypted event's
   *     member state, while the room name can fall back to the Matrix SDK's
   *     room name, which is sometimes a hash.
   * Defaults to "sender".
   */
  directTitlePrefers?: "sender" | "room";
}

const usable = (value: string | null | undefined): string | null => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
};

/**
 * Does `value` look like a raw Matrix user ID (`@PXXX...:server`)?
 *
 * The push pipeline falls back to the bare sender id when member state has
 * not loaded yet, and an opaque id is never worth showing — it was the
 * original WEE-11 / forta-bugs#660 bug. Mirrors `isMatrixId` in
 * `FortaFirebaseMessagingService` and in the iOS Notification Service
 * Extension.
 */
const isMatrixId = (value: string): boolean => value.startsWith("@") && value.includes(":");

const usableSender = (value: string | null | undefined): string | null => {
  const name = usable(value);
  return name !== null && isMatrixId(name) ? null : name;
};

/**
 * Build the visible title/body pair for an inbound message notification.
 *
 * A group push without a known room name cannot be marked as "group" — there
 * is nothing to show — so it degrades to the direct-chat layout rather than
 * inventing a placeholder.
 */
export const buildMessageNotificationContent = (
  input: MessageNotificationInput,
): MessageNotificationContent => {
  const senderName = usableSender(input.senderName);
  const roomName = usable(input.roomName);

  if (input.isGroup && roomName) {
    return {
      title: roomName,
      body: senderName ? `${senderName}: ${input.body}` : input.body,
    };
  }

  const direct = input.directTitlePrefers === "room"
    ? roomName ?? senderName
    : senderName ?? roomName;

  return {
    title: direct ?? input.fallbackTitle,
    body: input.body,
  };
};
