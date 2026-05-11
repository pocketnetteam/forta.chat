/**
 * Session 31 — Bastyon ↔ Forta call interop dedup.
 *
 * When a Forta user is also logged into Bastyon on the same device, or when
 * Matrix re-emits the same `m.call.invite` event (sync retry, native FCM
 * ringer + JS sync racing for the same callId), the SDK can fire
 * `Call.incoming` more than once for a single underlying call. The second
 * fire shows a phantom incoming-call UI on top of the original one, and the
 * user has to dismiss two competing ringers — exactly what #644 reports on
 * Xiaomi 12X / 14T.
 *
 * This registry keeps a short-lived in-memory record of every callId we have
 * already routed through `handleIncomingCall`. The window is bounded so a
 * legitimate retry of the same callId after the original ended (e.g. caller
 * retried minutes later — extremely rare but not impossible if the homeserver
 * retains the event id) can still ring through.
 *
 * Pure module-level state — no Vue / Pinia coupling — so unit tests can
 * exercise it deterministically with `vi.useFakeTimers`.
 */

/**
 * How long to remember a seen callId before allowing it through again.
 * Mirrors the Matrix SDK's `CALL_TIMEOUT_MS` from
 * `matrix-js-sdk-bastyon/lib/webrtc/call.js` (currently 60_000), so an
 * invite that legitimately rings for the full minute and is then re-emitted
 * by pathological homeservers will still be deduped. The SDK does NOT
 * export this constant, so if the Bastyon fork ever bumps it this value
 * needs a manual update — there is no compile-time link.
 */
export const INCOMING_CALL_DEDUP_WINDOW_MS = 60_000;

const seenCallIds = new Set<string>();
const pendingClearTimers = new Map<string, ReturnType<typeof setTimeout>>();

function isUsableCallId(callId: string): boolean {
  return typeof callId === "string" && callId.trim().length > 0;
}

export function isIncomingCallSeen(callId: string): boolean {
  if (!isUsableCallId(callId)) return false;
  return seenCallIds.has(callId);
}

export function markIncomingCallSeen(callId: string): void {
  if (!isUsableCallId(callId)) return;

  // Replace any pending auto-clear so a re-mark resets the window. Without
  // this a slow second invite arriving near the end of the original
  // window would expire immediately, which would defeat the dedup.
  const existing = pendingClearTimers.get(callId);
  if (existing) clearTimeout(existing);

  seenCallIds.add(callId);
  const timer = setTimeout(() => {
    seenCallIds.delete(callId);
    pendingClearTimers.delete(callId);
  }, INCOMING_CALL_DEDUP_WINDOW_MS);
  pendingClearTimers.set(callId, timer);
}

export function clearIncomingCallSeen(callId: string): void {
  if (!isUsableCallId(callId)) return;
  const timer = pendingClearTimers.get(callId);
  if (timer) {
    clearTimeout(timer);
    pendingClearTimers.delete(callId);
  }
  seenCallIds.delete(callId);
}

export function __resetIncomingCallDedupForTests(): void {
  for (const timer of pendingClearTimers.values()) clearTimeout(timer);
  pendingClearTimers.clear();
  seenCallIds.clear();
}
