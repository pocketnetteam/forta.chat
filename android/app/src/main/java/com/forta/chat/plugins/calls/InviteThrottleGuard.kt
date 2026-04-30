package com.forta.chat.plugins.calls

/**
 * Session 25 / S4 stale-invite guard for the FCM ringer path.
 *
 * Background: when FCM delivery degrades on Android (S3 — foreground
 * service abuse, Doze, rate-limit), the homeserver retains the invite
 * and flushes it minutes later. The Matrix SDK's lifetime timer covers
 * the JS path, but `FortaFirebaseMessagingService.onMessageReceived`
 * launches `IncomingCallActivity` from the push payload BEFORE the SDK
 * even sees the event. Without this guard the user is woken up by a
 * ringer for a call the caller cancelled minutes ago — exactly the
 * S4 false-positive scenario.
 *
 * Pure Kotlin object so it is unit-testable from `androidUnitTest`
 * without spinning up an Android emulator.
 */
object InviteThrottleGuard {

    /**
     * Default invite lifetime when the FCM payload does not specify one.
     * Matches the Matrix SDK's `CALL_TIMEOUT_MS` (60s).
     */
    const val DEFAULT_INVITE_LIFETIME_MS: Long = 60_000L

    /**
     * Hard ceiling on lifetime. Some homeservers / forks echo back
     * surprisingly large lifetimes (e.g. 1 hour) which would silently
     * disable the guard. Five minutes is well past any realistic
     * ring-then-pickup window and still tight enough to prevent the user
     * from being woken up by an invite the caller cancelled long ago.
     */
    const val MAX_INVITE_LIFETIME_MS: Long = 5 * 60_000L

    /**
     * Returns true when the invite is older than `min(lifetime, MAX)`.
     *
     * @param sentTimeMs proxy for `event.origin_server_ts`. On the FCM
     *   path use `RemoteMessage.sentTime`. Defensive: a non-positive
     *   value is treated as expired so we never let a malformed invite
     *   through.
     * @param nowMs current wall clock. Production callers pass
     *   `System.currentTimeMillis()`; tests pass a fixed value.
     * @param lifetimeMs `event.content.lifetime`. Pass `null` to use
     *   [DEFAULT_INVITE_LIFETIME_MS].
     */
    fun isExpired(
        sentTimeMs: Long,
        nowMs: Long,
        lifetimeMs: Long? = null,
    ): Boolean {
        if (sentTimeMs <= 0L) return true
        val rawLifetime = lifetimeMs?.takeIf { it > 0L } ?: DEFAULT_INVITE_LIFETIME_MS
        val effective = rawLifetime.coerceAtMost(MAX_INVITE_LIFETIME_MS)
        val age = nowMs - sentTimeMs
        return age >= effective
    }
}
