package com.forta.chat.plugins.calls

import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Regressions in CallActivity's static state:
 * - a screen reopened from the ongoing-call notification showed the mic as on
 *   while the native track stayed muted, and counted from 00:00;
 * - a finishing screen's onDestroy, running after the next call's screen was
 *   created, cleared that screen's callbacks and router listener.
 */
class CallActivityReopenContractTest {

    private val source = listOf(
        "src/main/java/com/forta/chat/plugins/calls/CallActivity.kt",
        "android/app/src/main/java/com/forta/chat/plugins/calls/CallActivity.kt",
    ).map { File(it) }.first { it.exists() }.readText()

    @Test
    fun reopenedScreenReadsMuteFromTheNativeTrack() {
        assertTrue(source.contains("isMuted = WebRTCPlugin.manager?.isAudioEnabled() == false"))
    }

    @Test
    fun reopenedScreenCountsFromWhenTheMediaConnected() {
        val start = source.indexOf("fun handleCallConnected()")
        val body = source.substring(start, source.indexOf("handler.post(timerRunnable)", start))
        assertTrue(body.contains("mediaConnectedAtMs"))
    }

    @Test
    fun staleScreenLeavesTheNewScreensCallbacks() {
        val start = source.indexOf("override fun onDestroy()")
        val body = source.substring(start, source.indexOf("super.onDestroy()", start))
        assertTrue(body.contains("val isCurrent = currentInstance === this || currentInstance == null"))
        assertTrue(Regex("""if \(isCurrent\) \{\s*onCallEnded = null""").containsMatchIn(body))
        assertTrue(body.contains("if (isCurrent) audioRouter.setUiListener(null)"))
    }
}
