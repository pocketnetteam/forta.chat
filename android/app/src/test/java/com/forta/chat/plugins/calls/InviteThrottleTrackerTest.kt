package com.forta.chat.plugins.calls

import org.junit.Assert.assertEquals
import org.junit.Test

class InviteThrottleTrackerTest {

    @Test
    fun rollingWindowKeepsLastN() {
        val tracker = InviteThrottleTracker(maxRecords = 3)
        for (i in 1..5) {
            tracker.append(
                InviteThrottleTracker.Record(
                    receivedAtMs = i.toLong() * 1_000L,
                    sentAtMs = i.toLong() * 1_000L - 100L,
                    expired = false,
                    callId = "call-$i",
                )
            )
        }
        val snapshot = tracker.snapshot()
        assertEquals(3, snapshot.size)
        assertEquals("call-3", snapshot[0].callId)
        assertEquals("call-5", snapshot[2].callId)
    }

    @Test
    fun deliveryLatencyMsComputed() {
        val record = InviteThrottleTracker.Record(
            receivedAtMs = 1_500L,
            sentAtMs = 1_000L,
            expired = false,
            callId = null,
        )
        assertEquals(500L, record.deliveryLatencyMs)
    }

    @Test
    fun expiredCountWithinWindow() {
        val tracker = InviteThrottleTracker(maxRecords = 5)
        val now = 100_000L
        // Two expired in last 30s, one expired older
        tracker.append(rec(now - 5_000L, expired = true))
        tracker.append(rec(now - 20_000L, expired = true))
        tracker.append(rec(now - 60_000L, expired = true))
        // Fresh non-expired in window
        tracker.append(rec(now - 10_000L, expired = false))

        assertEquals(2, tracker.expiredCountWithin(30_000L, now))
        assertEquals(3, tracker.expiredCountWithin(120_000L, now))
        assertEquals(0, tracker.expiredCountWithin(1_000L, now))
    }

    @Test
    fun clearEmptiesSnapshot() {
        val tracker = InviteThrottleTracker(maxRecords = 3)
        tracker.append(rec(1_000L, expired = false))
        tracker.clear()
        assertEquals(0, tracker.snapshot().size)
    }

    private fun rec(receivedAtMs: Long, expired: Boolean): InviteThrottleTracker.Record =
        InviteThrottleTracker.Record(
            receivedAtMs = receivedAtMs,
            sentAtMs = receivedAtMs - 100L,
            expired = expired,
            callId = null,
        )
}
