package com.forta.chat.plugins.calls

import android.content.Context
import android.content.SharedPreferences

/**
 * Persistent dedup for cancelled call invites (Session 62).
 *
 * The FCM service already drops duplicate `m.call.invite` retries via
 * the in-memory `lastRingingCallId` field, but that field is cleared
 * the moment we observe the matching hangup/reject/select_answer —
 * which is exactly when the next delayed retry tends to land. The
 * homeserver continues to flush invites for several seconds after the
 * caller has hung up (FCM batching, Doze quota release, Tor relay
 * latency on the callee side), and those late retries used to wake
 * the callee back into a full-screen ringer for a call that no longer
 * existed.
 *
 * Strategy: when a cancel event arrives we stamp the callId in this
 * store with an expiry [DEFAULT_TTL_MS] in the future. Subsequent
 * `m.call.invite` deliveries for the same callId are silently
 * suppressed until the TTL elapses. Storage is SharedPreferences so
 * the suppression survives the FCM service process being torn down
 * between pushes — without persistence the dedup is useless because
 * the late retry typically spawns a fresh service instance.
 *
 * Closes forta-bugs#737 (ring continues after caller cancels) and
 * #722 (5 FCM invites for one call → stacked ringers). The contract
 * is locked down by `CancelledCallStoreTest` in the test source set.
 */
class CancelledCallStore(context: Context) {

    private val prefs: SharedPreferences =
        context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    /**
     * Stamp [callId] as cancelled. Subsequent [isCancelled] lookups
     * return `true` until `nowMs + ttlMs`. Idempotent — repeated
     * marks for the same callId always extend the window from the
     * newer timestamp so a late hangup never shortens the dedup
     * relative to an earlier one.
     */
    fun markCancelled(
        callId: String,
        ttlMs: Long = DEFAULT_TTL_MS,
        nowMs: Long = System.currentTimeMillis(),
    ) {
        gc(nowMs)
        // Synchronous commit on purpose: the FCM service is routinely
        // killed seconds after this push returns, and the very next
        // delayed invite for the same callId tends to spawn a fresh
        // process. An async `.apply()` can lose to the kill window —
        // the new process would then read 0L and re-ring the cancelled
        // call. commit() blocks for ~ms on flash and the service has
        // plenty of budget inside its 10s execution window.
        prefs.edit().putLong(callId, nowMs + ttlMs).commit()
    }

    /**
     * `true` if [callId] was marked cancelled within the TTL window.
     * The boundary tick (`expiry == nowMs`) is treated as already
     * past — the suppression must not flicker at the exact expiry.
     */
    fun isCancelled(
        callId: String,
        nowMs: Long = System.currentTimeMillis(),
    ): Boolean {
        val expiry = prefs.getLong(callId, 0L)
        return expiry > nowMs
    }

    /**
     * Drop entries whose expiry has already passed. Called from
     * [markCancelled] so the store cannot grow unbounded — call
     * volume is low (one entry per cancelled call, TTL ~60s) so an
     * O(n) sweep is cheap in practice.
     */
    fun gc(nowMs: Long = System.currentTimeMillis()) {
        val editor = prefs.edit()
        prefs.all.forEach { (key, value) ->
            val expiry = (value as? Long) ?: 0L
            if (expiry <= nowMs) editor.remove(key)
        }
        editor.apply()
    }

    companion object {
        /**
         * Suppression window after a cancel. Aligned with
         * `InviteThrottleGuard.DEFAULT_INVITE_LIFETIME_MS` (60s): the
         * Session 25 stale-invite filter starts dropping invites once
         * they outlive their lifetime, so anything we don't catch here
         * is caught there. A shorter TTL would leave a gap where a
         * delayed retry is neither cancelled-yet nor stale-yet and
         * leaks through.
         */
        const val DEFAULT_TTL_MS: Long = 60_000L
        private const val PREFS_NAME = "forta_cancelled_calls"
    }
}
