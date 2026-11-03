package com.forta.chat.plugins.calls

import android.media.AudioManager
import android.telecom.Connection
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * "Incoming call rings very quietly" (Samsung SM-A528B, 2026-10-13): Android routes the
 * ringtone to the earpiece while the phone is in an in-call audio mode. A
 * MODE_IN_COMMUNICATION left behind by an earlier call (no Telecom ringing focus to
 * override it: Android 7, a disabled calling account) made the next ring quiet. On
 * Android 12+ that request reads as MODE_NORMAL while idle and returns with the next capture.
 */
class RingerModePolicyTest {

    @Test
    fun withdrawsTheModeWhenNothingOfOursOwnsIt() {
        assertTrue(RingerModePolicy.shouldReleaseModeForRing(routerActive = false, liveCall = false))
    }

    @Test
    fun keepsTheModeOfACallThatIsStillGoing() {
        assertFalse(RingerModePolicy.shouldReleaseModeForRing(routerActive = true, liveCall = false))
        assertFalse(RingerModePolicy.shouldReleaseModeForRing(routerActive = false, liveCall = true))
    }

    @Test
    fun reportsADropWhenTheModeLeftVoipOrOurSessionWasOpen() {
        val comm = AudioManager.MODE_IN_COMMUNICATION
        val normal = AudioManager.MODE_NORMAL
        assertTrue(RingerModePolicy.droppedStrandedMode(comm, normal, sessionMarkerOpen = false))
        // SM-A528B, Android 14: an idle request of ours reads as MODE_NORMAL.
        assertTrue(RingerModePolicy.droppedStrandedMode(normal, normal, sessionMarkerOpen = true))
        assertFalse(RingerModePolicy.droppedStrandedMode(normal, normal, sessionMarkerOpen = false))
        // Another app's VoIP call keeps its mode.
        assertFalse(RingerModePolicy.droppedStrandedMode(comm, comm, sessionMarkerOpen = true))
        assertFalse(RingerModePolicy.droppedStrandedMode(AudioManager.MODE_RINGTONE, AudioManager.MODE_RINGTONE, sessionMarkerOpen = false))
    }

    @Test
    fun aCallPastRingingOrTheCallServiceIsALiveCall() {
        assertTrue(RingerModePolicy.isLiveCall(Connection.STATE_ACTIVE, foregroundServiceRunning = false))
        assertTrue(RingerModePolicy.isLiveCall(Connection.STATE_DIALING, foregroundServiceRunning = false))
        assertTrue(RingerModePolicy.isLiveCall(Connection.STATE_HOLDING, foregroundServiceRunning = false))
        assertTrue(RingerModePolicy.isLiveCall(null, foregroundServiceRunning = true))
    }

    @Test
    fun aRingingOrEmptySlotIsNoLiveCall() {
        // The ringing connection is the incoming call itself.
        assertFalse(RingerModePolicy.isLiveCall(Connection.STATE_RINGING, foregroundServiceRunning = false))
        assertFalse(RingerModePolicy.isLiveCall(Connection.STATE_DISCONNECTED, foregroundServiceRunning = false))
        assertFalse(RingerModePolicy.isLiveCall(null, foregroundServiceRunning = false))
    }

    @Test
    fun labelsTheSlotForTheReport() {
        assertEquals("none", RingerModePolicy.slotLabel(null, isThisCall = false))
        assertEquals("RINGING", RingerModePolicy.slotLabel(Connection.STATE_RINGING, isThisCall = true))
        assertEquals("ACTIVE, another call", RingerModePolicy.slotLabel(Connection.STATE_ACTIVE, isThisCall = false))
        assertEquals("MODE_IN_COMMUNICATION", RingerModePolicy.modeName(AudioManager.MODE_IN_COMMUNICATION))
        assertEquals("unknown", RingerModePolicy.modeName(null))
    }

    @Test
    fun aRecentEnsureIsACallBeingSetUp() {
        assertTrue(RingerModePolicy.isSettingUp(ensureAtMs = 1_000L, nowMs = 5_000L))
        assertFalse(RingerModePolicy.isSettingUp(ensureAtMs = 1_000L, nowMs = 1_000L + RingerModePolicy.SETUP_GRACE_MS))
        assertFalse(RingerModePolicy.isSettingUp(ensureAtMs = null, nowMs = 5_000L))
    }
}
