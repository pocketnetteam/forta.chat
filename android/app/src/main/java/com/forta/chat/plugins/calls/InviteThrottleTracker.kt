package com.forta.chat.plugins.calls

/**
 * Session 25 / S3: in-memory rolling tracker for FCM `m.call.invite`
 * events. Used by [InviteThrottleGuard]'s consumers to surface a snapshot
 * of recent invite delivery latencies in bug reports.
 *
 * Records last [maxRecords] entries: timing, FCM priority and what became of the push.
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
        /** `RemoteMessage.priority` as delivered (1 high, 2 normal, 0 unknown). */
        val priority: Int = 0,
        /** `RemoteMessage.originalPriority` as sent; differs when FCM downgraded it. */
        val originalPriority: Int = 0,
        /** [InvitePushPolicy.Outcome.wire]: what became of the push. */
        val outcome: String = InvitePushPolicy.Outcome.RANG.wire,
    ) {
        val deliveryLatencyMs: Long get() = receivedAtMs - sentAtMs

        /** "missing" when the push carried no send time: the latency means nothing then. */
        val sentTimeSource: String get() = if (sentAtMs > 0L) "fcm" else "missing"

        /** Field map handed to JS (CallPlugin.getInviteThrottleSnapshot). */
        fun toWireMap(): Map<String, Any> = mapOf(
            "receivedAtMs" to receivedAtMs,
            "sentAtMs" to sentAtMs,
            "deliveryLatencyMs" to deliveryLatencyMs,
            "expired" to expired,
            "callId" to (callId ?: ""),
            "priority" to priority,
            "originalPriority" to originalPriority,
            "sentTimeSource" to sentTimeSource,
            "outcome" to outcome,
        )
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
