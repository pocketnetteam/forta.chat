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
}
