/**
 * TTL guard for `m.call.invite` events.
 *
 * Background — Session 25 / S4: when FCM delivery degrades on Android, the
 * invite is retained on the homeserver and flushed during the next `/sync`
 * (often minutes later). The Matrix SDK already arms a `setTimeout(...,
 * invite.lifetime - event.getLocalAge())` that fires Hangup immediately if
 * the invite is past its lifetime, so the SDK-driven path is safe.
 *
 * The two places that need an explicit guard are:
 *   1. `feedMissedInviteToSDK` — the cold-start-from-push recovery walks
 *      the timeline and force-feeds invite events back into
 *      `callEventHandler.onRoomTimeline`. Feeding a long-stale invite here
 *      makes the SDK ring/flash the UI for a beat before its own lifetime
 *      timer fires, and triggers an extra round of native UI churn.
 *   2. `FortaFirebaseMessagingService` — the FCM path launches
 *      `IncomingCallActivity` from the push payload BEFORE Matrix /sync
 *      delivers the event, so the SDK timer cannot help. The Kotlin side
 *      uses the same logic via the `RemoteMessage.sentTime` proxy.
 *
 * The pure function lives here so both call sites share one definition and
 * regressions are caught by a single test file.
 */

/**
 * Default invite lifetime when the content does not specify one. Matches
 * the Matrix SDK's `CALL_TIMEOUT_MS` (60s).
 */
export const DEFAULT_INVITE_LIFETIME_MS = 60_000;

/**
 * Hard ceiling on lifetime. Some homeservers / forks echo back surprisingly
 * large lifetimes (e.g. 1 hour) which would silently disable the guard.
 * Five minutes is well past any realistic ring-then-pickup window and
 * still tight enough to prevent the user from being woken up by an invite
 * the caller cancelled long ago.
 */
export const MAX_INVITE_LIFETIME_MS = 5 * 60_000;

export interface InviteAgeInput {
  /** `event.origin_server_ts` (or `RemoteMessage.sentTime` for the FCM path). */
  originServerTs: number;
  /** `event.content.lifetime`. Falls back to `DEFAULT_INVITE_LIFETIME_MS` when absent. */
  lifetime?: number | null;
  /** Override "now" — only used in tests. Production callers omit. */
  now?: number;
}

/**
 * Returns true when the invite is older than `min(lifetime, MAX_INVITE_LIFETIME_MS)`.
 *
 * Defensive: a non-positive `originServerTs` (event with corrupt or missing
 * timestamp) is treated as expired so we never let a malformed invite
 * through into the SDK or onto the screen.
 */
export function isInviteEventExpired(input: InviteAgeInput): boolean {
  const { originServerTs } = input;
  if (!originServerTs || originServerTs <= 0) return true;

  const now = input.now ?? Date.now();
  const rawLifetime =
    typeof input.lifetime === "number" && input.lifetime > 0
      ? input.lifetime
      : DEFAULT_INVITE_LIFETIME_MS;
  const lifetime = Math.min(rawLifetime, MAX_INVITE_LIFETIME_MS);
  const age = now - originServerTs;
  return age >= lifetime;
}
