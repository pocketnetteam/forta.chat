/**
 * Push-layer dedup for incoming-call notifications (WEE-35 Task 4 /
 * forta-bugs#772, #760, #893).
 *
 * FCM can deliver the same `m.call.invite` push more than once (retries,
 * multi-delivery), and on a dual-install device the same call also surfaces via
 * Matrix /sync. This guard suppresses a *second push* for the same call_id
 * within a short window so we don't fire the native ringer twice.
 *
 * IMPORTANT: this is intentionally separate from the sync-call dedup in
 * `features/video-calls/model/incoming-call-dedup.ts`. The push only triggers
 * an early native ring; the real `MatrixCall` object arrives later via /sync and
 * must NOT be deduped against the push — sharing one store would drop the real
 * call and make it unanswerable. The window here is short (10s) and the store
 * is push-private.
 *
 * It cannot suppress Bastyon's own ring (a different app) — that requires a
 * shared native mechanism, out of scope here.
 */

/** Window within which a repeated call push for the same id is a duplicate. */
export const CALL_PUSH_DEDUP_WINDOW_MS = 10_000;

const lastSeen = new Map<string, number>();

/**
 * Whether a call push should trigger a ring. Returns false for a duplicate
 * push (same call_id seen within the window). Records the id on a ring-worthy
 * call. `nowMs` is injectable for tests.
 */
export function shouldRingForCallPush(
  callId: string,
  nowMs: number = Date.now(),
  windowMs: number = CALL_PUSH_DEDUP_WINDOW_MS
): boolean {
  // No stable id → can't dedup; ring to avoid dropping a real call.
  if (!callId) return true;

  const prev = lastSeen.get(callId);
  if (prev !== undefined && nowMs - prev < windowMs) {
    return false;
  }

  lastSeen.set(callId, nowMs);

  // Opportunistic GC so the map can't grow unbounded across a long session.
  for (const [id, ts] of lastSeen) {
    if (nowMs - ts >= windowMs) lastSeen.delete(id);
  }

  return true;
}

/** Clear all dedup state (test isolation / logout). */
export function resetCallPushDedup(): void {
  lastSeen.clear();
}
