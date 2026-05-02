package com.forta.chat.plugins.calls

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Unit tests for [InviteThrottleGuard]. Pure Kotlin — no Android
 * dependencies, runs as part of `./gradlew test` (JVM unit tests).
 *
 * Mirrors `src/shared/lib/native-calls/__tests__/invite-ttl.test.ts`
 * so JS and native sides agree on the staleness window.
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
    fun nonPositiveTimestampTreatedAsExpired() {
        assertTrue(InviteThrottleGuard.isExpired(sentTimeMs = 0L, nowMs = now))
        assertTrue(InviteThrottleGuard.isExpired(sentTimeMs = -1L, nowMs = now))
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
