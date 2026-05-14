package com.forta.chat.plugins.calls

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Unit tests for the cancelled-call TTL contract (Session 62).
 *
 * Codifies the dedup behaviour the FCM service relies on to suppress
 * delayed `m.call.invite` retries that arrive after the caller has
 * already cancelled the call via `m.call.hangup` / `m.call.reject` /
 * `m.call.select_answer`.
 *
 * The production [CancelledCallStore] persists state in
 * SharedPreferences; this suite exercises an in-memory mirror of the
 * same algorithm so it can run as a fast JVM unit test without
 * Robolectric. The integration with the FCM service is verified
 * manually (two devices) per the session checklist.
 */
class CancelledCallStoreTest {

    @Test
    fun `freshly marked callId is reported cancelled until ttl elapses`() {
        val store = InMemoryCancelledStore()
        val callId = "call_abc"
        store.markCancelled(callId, ttlMs = 30_000L, nowMs = 1_000L)
        assertTrue(store.isCancelled(callId, nowMs = 1_500L))
    }

    @Test
    fun `expired callId is no longer reported cancelled`() {
        val store = InMemoryCancelledStore()
        val callId = "call_old"
        store.markCancelled(callId, ttlMs = 100L, nowMs = 0L)
        assertTrue(store.isCancelled(callId, nowMs = 50L))
        assertFalse(store.isCancelled(callId, nowMs = 200L))
    }

    @Test
    fun `unknown callId is never reported cancelled`() {
        val store = InMemoryCancelledStore()
        assertFalse(store.isCancelled("never_cancelled", nowMs = 1_000L))
    }

    @Test
    fun `gc removes only expired entries`() {
        val store = InMemoryCancelledStore()
        store.markCancelled("a", ttlMs = 100L, nowMs = 0L)
        store.markCancelled("b", ttlMs = 5_000L, nowMs = 0L)
        store.gc(nowMs = 200L)
        assertFalse(store.isCancelled("a", nowMs = 200L))
        assertTrue(store.isCancelled("b", nowMs = 200L))
    }

    @Test
    fun `boundary expiry is no longer cancelled (strict greater-than)`() {
        // The implementation uses `expiry > nowMs`: at the exact tick
        // `expiry == nowMs` the entry has just stopped being cancelled.
        // One tick before is still inside the window.
        val store = InMemoryCancelledStore()
        store.markCancelled("call", ttlMs = 100L, nowMs = 0L)
        assertFalse(store.isCancelled("call", nowMs = 100L))
        assertTrue(store.isCancelled("call", nowMs = 99L))
    }

    @Test
    fun `markCancelled refreshes expiry for repeated hangup events`() {
        // Hangup can arrive twice (Telecom + JS forward) for the same
        // callId. Each call extends the suppression window from the
        // newer timestamp — older expiries must not "win".
        val store = InMemoryCancelledStore()
        store.markCancelled("call", ttlMs = 100L, nowMs = 0L)
        store.markCancelled("call", ttlMs = 30_000L, nowMs = 50L)
        assertTrue(store.isCancelled("call", nowMs = 10_000L))
    }
}

/**
 * Pure-data mirror of [CancelledCallStore] used to lock down the TTL
 * algorithm without pulling in Android SharedPreferences. Kept in the
 * test source set on purpose — production code must use the
 * SharedPreferences-backed [CancelledCallStore] so the suppression
 * survives the FCM-service process being torn down between pushes.
 */
internal class InMemoryCancelledStore {
    private val data = mutableMapOf<String, Long>()

    fun markCancelled(callId: String, ttlMs: Long, nowMs: Long) {
        gc(nowMs)
        data[callId] = nowMs + ttlMs
    }

    fun isCancelled(callId: String, nowMs: Long): Boolean {
        val expiry = data[callId] ?: return false
        return expiry > nowMs
    }

    fun gc(nowMs: Long) {
        data.entries.removeAll { it.value <= nowMs }
    }
}
