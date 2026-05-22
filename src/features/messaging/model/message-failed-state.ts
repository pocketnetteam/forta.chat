import type { Message } from "@/entities/chat/model/types";
import { MessageStatus } from "@/entities/chat/model/types";

/**
 * Decide whether a UI Message should render the red "retry" indicator.
 *
 * A message is "failed for retry" only when:
 *  1. Its derived status is `MessageStatus.failed`, AND
 *  2. The server-issued eventId never replaced the clientId in `Message.id`
 *     (i.e. `id === _key`, where `_key` is the stable clientId set in
 *     `localToMessage`).
 *
 * When `id !== _key` the local row already picked up an eventId — that
 * happens via `confirmSent` on a successful send, or via `upsertFromServer`
 * when the Matrix `/sync` echo arrives before the queue's catch-handler
 * runs. In both cases the peer received the message; showing a retry button
 * on top of it is the WEE-40 false-failed bug.
 */
export function isMessageFailedForRetry(message: Pick<Message, "status" | "id" | "_key">): boolean {
  if (message.status !== MessageStatus.failed) return false;
  // Without a `_key` we cannot tell whether the id has flipped; fall back to
  // the status alone so this helper stays robust against missing fields
  // from mapper edge cases.
  if (message._key === undefined) return true;
  return message.id === message._key;
}
