import { getChatDb, isChatDbReady, type CallProvider } from "@/shared/lib/local-db";
import { getMatrixClientService } from "@/entities/matrix/model/matrix-client";
import { useAuthStore } from "@/entities/auth";
import { MessageType, type CallLinkInfo } from "@/entities/chat/model/types";
import { buildCallLinkBody, callLinkPreview } from "@/shared/lib/call-link";

/**
 * Send an external call-link message into a room (WEE-57).
 *
 * Mirrors the local-first send path of `sendTransferMessage`: optimistic
 * insert into Dexie, then enqueue a `send_message` op whose body is the
 * call-link JSON envelope (so it rides inside the E2E encryption envelope).
 * The receiver reconstructs the rich card via `parseCallLinkBody`.
 *
 * Returns true when the message was made visible locally (sent or failed),
 * false when prerequisites (DB / room) were missing.
 */
export async function sendCallLink(
  roomId: string,
  provider: CallProvider,
  kind: "voice" | "video",
): Promise<boolean> {
  if (!roomId) return false;

  const authStore = useAuthStore();
  const info: CallLinkInfo = {
    provider: provider.kind,
    kind,
    url: provider.urlTemplate,
    label: provider.label,
  };
  const displayContent = callLinkPreview(info);
  const body = buildCallLinkBody(info);

  if (!isChatDbReady()) {
    console.error("[sendCallLink] local DB not ready — cannot send call link");
    return false;
  }

  let localClientId: string | undefined;
  try {
    const dbKit = getChatDb();

    // 1. Optimistic insert — card appears in UI immediately via liveQuery.
    const localMsg = await dbKit.messages.createLocal({
      roomId,
      senderId: authStore.address ?? "",
      content: displayContent,
      type: MessageType.callLink,
      callLinkInfo: info,
    });
    localClientId = localMsg.clientId;

    // 2. Validate readiness AFTER insert so a not-ready client still shows
    //    the message (as failed) rather than silently dropping it.
    const matrixService = getMatrixClientService();
    if (!matrixService.isReady()) {
      console.error("[sendCallLink] Matrix client not ready — saved locally as failed");
      await dbKit.messages.markFailed(localClientId);
      return true;
    }

    // 3. Enqueue for background sync — reuses the encrypted text path.
    await dbKit.syncEngine.enqueue("send_message", roomId, { content: body }, localMsg.clientId);
    return true;
  } catch (e) {
    console.error("[sendCallLink] Dexie path failed:", e);
    if (localClientId) {
      try { await getChatDb().messages.markFailed(localClientId); } catch { /* already logged */ }
      return true;
    }
    return false;
  }
}
