package com.forta.chat.plugins.calls

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Regression tests for [CallNotificationConfig].
 *
 * Anchors the channel-migration contract behind WEE-18:
 *   * forta-bugs#768 — Xiaomi 12X silent push (no ringtone on incoming call)
 *
 * NotificationChannel itself is Android-framework-only, so we verify the
 * spec the production code derives the channel from. If anything here
 * regresses the spec back to silent / muted / non-public, this test fails
 * before users do.
 */
class CallNotificationConfigTest {

    @Test
    fun `migration channel id differs from legacy ids`() {
        for (legacyId in CallNotificationConfig.LEGACY_INCOMING_CALL_CHANNEL_IDS) {
            assertNotEquals(
                "Migration target must use a new id so Android recreates the channel with the fixed settings",
                legacyId,
                CallNotificationConfig.INCOMING_CALL_CHANNEL_ID,
            )
        }
    }

    @Test
    fun `legacy ids include the original v1 calls channel`() {
        assertTrue(
            "Must delete the original 'calls' channel so its silent-from-old-install state cannot persist",
            CallNotificationConfig.LEGACY_INCOMING_CALL_CHANNEL_IDS.contains("calls"),
        )
    }

    @Test
    fun `incoming-call spec has importance MAX so it surfaces over lock screen`() {
        val spec = CallNotificationConfig.incomingCallChannelSpec("Calls", "desc")
        // NotificationManager.IMPORTANCE_MAX
        assertEquals(5, spec.importance)
    }

    @Test
    fun `incoming-call spec sets ringtone (regression for #768)`() {
        val spec = CallNotificationConfig.incomingCallChannelSpec("Calls", "desc")
        assertTrue(
            "Channel must request a ringtone — silent channel was the #768 root cause on Xiaomi MIUI",
            spec.withRingtone,
        )
    }

    @Test
    fun `incoming-call spec enables vibration`() {
        val spec = CallNotificationConfig.incomingCallChannelSpec("Calls", "desc")
        assertTrue(spec.withVibration)
    }

    @Test
    fun `incoming-call spec is visible on the lockscreen`() {
        val spec = CallNotificationConfig.incomingCallChannelSpec("Calls", "desc")
        // Notification.VISIBILITY_PUBLIC
        assertEquals(
            "Lockscreen visibility must be PUBLIC — the ringer is the surface that wakes the screen",
            1,
            spec.lockscreenVisibility,
        )
    }

    @Test
    fun `incoming-call spec bypasses Do-Not-Disturb like the system dialer`() {
        val spec = CallNotificationConfig.incomingCallChannelSpec("Calls", "desc")
        assertTrue(
            "Incoming calls must ring through DND, mirroring system phone-app behaviour",
            spec.bypassDnd,
        )
    }

    @Test
    fun `spec id matches the active channel id constant`() {
        val spec = CallNotificationConfig.incomingCallChannelSpec("Calls", "desc")
        assertEquals(CallNotificationConfig.INCOMING_CALL_CHANNEL_ID, spec.id)
    }
}
