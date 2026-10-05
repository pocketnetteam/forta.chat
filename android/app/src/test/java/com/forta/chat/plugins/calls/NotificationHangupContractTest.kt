package com.forta.chat.plugins.calls

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Regression: "Hang up" on the ongoing-call notification closed the call screen and stopped
 * the service but never told JS, so no m.call.hangup went out and the peer stayed in a
 * silent call. The action must take the same path as the call screen's hang-up button.
 */
class NotificationHangupContractTest {

    private val service: String by lazy {
        listOf(
            "src/main/java/com/forta/chat/plugins/calls/CallForegroundService.kt",
            "android/app/src/main/java/com/forta/chat/plugins/calls/CallForegroundService.kt",
        ).map { File(it) }.first { it.exists() }.readText()
    }

    @Test
    fun hangupActionAsksJsToHangUp() {
        val start = service.indexOf("ACTION_HANGUP ->")
        assertTrue("ACTION_HANGUP branch not found", start >= 0)
        val branch = service.substring(start, service.indexOf("ACTION_STOP ->", start))
        assertTrue(branch.contains("CallActivity.onNativeHangup?.invoke()"))
        assertFalse("stopping the service first drops the call before JS hangs up", branch.contains("stopSelf()"))
    }

    /** Regression: a tap on the notification opened a bare CallActivity ("Unknown", video, no call id). */
    @Test
    fun contentIntentCarriesTheCall() {
        val start = service.indexOf("val contentIntent = Intent(this, CallActivity::class.java)")
        assertTrue("content intent not found", start >= 0)
        val block = service.substring(start, service.indexOf("val contentPendingIntent", start))
        assertTrue(block.contains("CallActivity.EXTRA_CALLER_NAME"))
        assertTrue(block.contains("CallActivity.EXTRA_CALL_TYPE"))
        assertTrue(block.contains("CallActivity.EXTRA_CALL_ID"))
    }

    /** A screen reopened mid-call showed "Connecting…" for the rest of the call. */
    @Test
    fun reopenedScreenPicksUpTheConnectedState() {
        val activity = listOf(
            "src/main/java/com/forta/chat/plugins/calls/CallActivity.kt",
            "android/app/src/main/java/com/forta/chat/plugins/calls/CallActivity.kt",
        ).map { File(it) }.first { it.exists() }.readText()
        assertTrue(activity.contains("if (mediaConnected) handleCallConnected()"))
    }
}
