package com.forta.chat.plugins.calls

/**
 * Session 25 / S3: in-memory rolling tracker for FCM `m.call.invite`
 * events. Used by [InviteThrottleGuard]'s consumers to surface a snapshot
 * of recent invite delivery latencies in bug reports.
 *
 * Records last [maxRecords] entries with `(receivedAtMs, sentAtMs, isExpired)`.
 * The bug-reporter pulls a snapshot to help split S1 (accept-crash) from
 * S3 (FCM throttle / Doze) when the auto-bug-reporter envelope is sent.
 *
 * Pure Kotlin object — no Android dependencies — so unit-testable from
 * `androidUnitTest` without an emulator.
 */
class InviteThrottleTracker(private val maxRecords: Int = 5) {

    data class Record(
        /** When [FortaFirebaseMessagingService.onMessageReceived] handled the push. */
        val receivedAtMs: Long,
        /** `RemoteMessage.sentTime` — homeserver send time (proxy for origin_server_ts). */
        val sentAtMs: Long,
        /** Was the invite already expired by the time we received it? */
        val expired: Boolean,
        /** `call_id` from the FCM payload, or null when missing. */
        val callId: String?,
    ) {
        val deliveryLatencyMs: Long get() = receivedAtMs - sentAtMs
    }

    private val records: ArrayDeque<Record> = ArrayDeque(maxRecords)
    private val lock = Any()

    fun append(record: Record) = synchronized(lock) {
        if (records.size >= maxRecords) records.removeFirst()
        records.addLast(record)
    }

    fun snapshot(): List<Record> = synchronized(lock) {
        records.toList()
    }

    /**
     * Last [windowMs]-window expired count. Used by the JS bug-reporter
     * to decide whether the user is in an active S3 throttle cycle.
     */
    fun expiredCountWithin(windowMs: Long, nowMs: Long): Int = synchronized(lock) {
        val cutoff = nowMs - windowMs
        records.count { it.expired && it.receivedAtMs >= cutoff }
    }

    fun clear() = synchronized(lock) { records.clear() }
}
