package com.forta.chat.plugins.calls

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Unit tests for [InviteThrottleGuard]. Pure Kotlin — no Android
 * dependencies, runs as part of `./gradlew test` (JVM unit tests).
 *
 * Mirrors `src/shared/lib/native-calls/__tests__/invite-ttl.test.ts`
 * for the lifetime/staleness window. Diverges on missing-timestamp
 * handling: JS-side `originServerTs <= 0` is corrupt-event (treated
 * expired); Kotlin-side `sentTime <= 0` is HMS-stub / FCM-collapse
 * (treated live — Session 41).
 */
class InviteThrottleGuardTest {

    private val now: Long = 1_700_000_000_000L

    @Test
    fun freshInviteWithinLifetimeNotExpired() {
        assertFalse(
            InviteThrottleGuard.isExpired(
                sentTimeMs = now - 5_000L,
                nowMs = now,
            )
        )
    }

    @Test
    fun inviteOlderThanDefaultLifetimeExpired() {
        assertTrue(
            InviteThrottleGuard.isExpired(
                sentTimeMs = now - InviteThrottleGuard.DEFAULT_INVITE_LIFETIME_MS - 1L,
                nowMs = now,
            )
        )
    }

    @Test
    fun explicitLifetimeOverridesDefault() {
        // 30s lifetime, 31s old → expired
        assertTrue(
            InviteThrottleGuard.isExpired(
                sentTimeMs = now - 31_000L,
                nowMs = now,
                lifetimeMs = 30_000L,
            )
        )
        // 30s lifetime, 29s old → not expired
        assertFalse(
            InviteThrottleGuard.isExpired(
                sentTimeMs = now - 29_000L,
                nowMs = now,
                lifetimeMs = 30_000L,
            )
        )
    }

    @Test
    fun nullLifetimeFallsBackToDefault() {
        assertTrue(
            InviteThrottleGuard.isExpired(
                sentTimeMs = now - InviteThrottleGuard.DEFAULT_INVITE_LIFETIME_MS - 1L,
                nowMs = now,
                lifetimeMs = null,
            )
        )
    }

    @Test
    fun `sentTime zero is treated as live invite (Huawei HMS-stub or FCM collapse)`() {
        // Some delivery paths erase the timestamp:
        //   - Huawei HMS-stub builds set RemoteMessage.sentTime to 0
        //   - FCM collapse_key dedup discards origin time on the second delivery
        // Treating these as expired silently dropped valid invites — Session 41
        // restores them as live. The lifetime check still applies once a real
        // sentTime is present, so this only relaxes the malformed-timestamp
        // edge-case, not the staleness window itself.
        assertFalse(
            "sentTime=0 must be treated as live (FCM collapsed or HMS stub)",
            InviteThrottleGuard.isExpired(sentTimeMs = 0L, nowMs = now, lifetimeMs = 60_000L)
        )
    }

    @Test
    fun `negative sentTime is treated as live invite`() {
        assertFalse(
            InviteThrottleGuard.isExpired(sentTimeMs = -1L, nowMs = now, lifetimeMs = 60_000L)
        )
    }

    @Test
    fun absurdlyLargeLifetimeClampedToCeiling() {
        // 1-hour echoed lifetime should not let a 6-min-old invite leak through.
        assertTrue(
            InviteThrottleGuard.isExpired(
                sentTimeMs = now - 6 * 60_000L,
                nowMs = now,
                lifetimeMs = 60 * 60_000L,
            )
        )
    }

    @Test
    fun exactBoundaryTreatedAsExpired() {
        assertTrue(
            InviteThrottleGuard.isExpired(
                sentTimeMs = now - 60_000L,
                nowMs = now,
                lifetimeMs = 60_000L,
            )
        )
    }
}
