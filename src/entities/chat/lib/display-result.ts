import { isUnresolvedName } from "./chat-helpers";
import { isEncryptedPlaceholder } from "@/shared/lib/utils/is-encrypted-placeholder";

export type DisplayState = "resolving" | "ready" | "failed";

export interface DisplayResult {
  state: DisplayState;
  text: string;
}

/**
 * Determine display state for a room title.
 * @param resolvedName - Result of resolveRoom() or resolveRoomName()
 * @param opts.gaveUp - Whether name resolution has permanently failed for this room
 * @param opts.roomId - Matrix room ID, used to generate unique fallback suffix
 */
export function getRoomTitleForUI(
  resolvedName: string,
  opts: { gaveUp: boolean; roomId: string; fallbackPrefix?: string },
): DisplayResult {
  if (!isUnresolvedName(resolvedName)) {
    return { state: "ready", text: resolvedName };
  }
  if (opts.gaveUp) {
    const suffix = opts.roomId.slice(1, 5).toUpperCase();
    const prefix = opts.fallbackPrefix ?? "Chat";
    return { state: "failed", text: `${prefix} #${suffix}` };
  }
  return { state: "resolving", text: "" };
}

/**
 * Determine display state for a user display name.
 * No "resolving" state — getDisplayName is synchronous with full fallback chain.
 */
export function getUserDisplayNameForUI(
  resolvedName: string,
  fallbackText: string,
): DisplayResult {
  if (isUnresolvedName(resolvedName)) {
    return { state: "failed", text: fallbackText };
  }
  return { state: "ready", text: resolvedName };
}

/**
 * Determine display state for a message preview in chat list.
 */
export function getMessagePreviewForUI(
  content: string | undefined | null,
  decryptionStatus: string | undefined | null,
  failedText: string,
  opts?: { timedOut?: boolean },
): DisplayResult {
  if (isEncryptedPlaceholder(content)) {
    // "failed" = decryption gave up; `timedOut` = the skeleton has shown long
    // enough (~10s) that we stop waiting and surface a human-readable label
    // instead of an indefinite shimmer. Either way, show the fallback text.
    if (decryptionStatus === "failed" || opts?.timedOut) {
      return { state: "failed", text: failedText };
    }
    return { state: "resolving", text: "" };
  }
  return { state: "ready", text: content ?? "" };
}
