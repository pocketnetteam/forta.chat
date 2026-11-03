import type { MatrixCall } from "matrix-js-sdk-bastyon/lib/webrtc/call";
import { useCallStore } from "@/entities/call";
import { getClient } from "./call-media";
import { hangup, rejectCall } from "./call-answer";

/**
 * Ends the call in progress before logout tears Matrix down, so the peer
 * learns of it.
 *
 * Logout cleared the call store and stopped the client: a caller whose call
 * rang here kept ringing until the invite expired, and a peer mid-call waited
 * for the ICE timeout. The SDK sends the reject or hangup asynchronously, and
 * stopping the client aborts requests in flight, so this waits until the event
 * has left the device, for at most {@link LOGOUT_CALL_END_TIMEOUT_MS}.
 */

/** Logout waits no longer than this for the end of the call to be sent. */
export const LOGOUT_CALL_END_TIMEOUT_MS = 3_000;
const POLL_MS = 100;

/** Statuses of a local echo that has not reached the server yet. */
const UNSENT = new Set(["queued", "sending", "encrypting", "not_sent"]);

/** Decline a call still ringing here, hang up any other; nothing for one already over. */
export function logoutCallAction(direction: string | undefined, state: string): "reject" | "hangup" | null {
  if (state === "ended") return null;
  if (direction === "inbound" && (state === "ringing" || state === "fledgling")) return "reject";
  return "hangup";
}

interface RoomEventLike {
  getType(): string;
  getSender(): string | null | undefined;
  getContent(): unknown;
  status?: string | null;
}

/** Our reject or hangup of [callId] has left this device. */
export function callEndSent(events: readonly RoomEventLike[], callId: string, me: string): boolean {
  return events.some((e) => {
    const type = e.getType();
    if (type !== "m.call.reject" && type !== "m.call.hangup") return false;
    if (e.getSender() !== me) return false;
    if ((e.getContent() as { call_id?: unknown } | null)?.call_id !== callId) return false;
    return !UNSENT.has(e.status ?? "");
  });
}

export async function endCallForLogout(timeoutMs: number = LOGOUT_CALL_END_TIMEOUT_MS): Promise<void> {
  const call = useCallStore().matrixCall as MatrixCall | null;
  if (!call) return;
  const action = logoutCallAction(call.direction, call.state);
  if (!action) return;
  const { callId, roomId } = call;
  if (action === "reject") rejectCall();
  else hangup();

  const client = getClient();
  const me: string | undefined = client?.getUserId?.();
  const room = roomId ? client?.getRoom?.(roomId) : null;
  if (!room || !me) return;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const events: RoomEventLike[] = [...(room.getLiveTimeline?.()?.getEvents?.() ?? [])];
    try {
      // Throws unless the client keeps pending events apart (pendingEventOrdering "detached").
      events.push(...(room.getPendingEvents?.() ?? []));
    } catch {
      /* the local echo is in the live timeline then */
    }
    if (callEndSent(events, callId, me)) return;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  console.warn("[call-service] logout: the end of the call was not confirmed sent; logging out anyway");
}
