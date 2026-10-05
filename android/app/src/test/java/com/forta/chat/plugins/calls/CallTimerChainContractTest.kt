package com.forta.chat.plugins.calls

import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Regression: handleCallConnected runs on every ICE CONNECTED/COMPLETED. Each
 * run posted another self-rescheduling timer chain, so after a reconnect the
 * call timer ran two or three times too fast and restarted at 00:00.
 */
class CallTimerChainContractTest {

    @Test
    fun connectedStartsTheTimerOnce() {
        val source = listOf(
            "src/main/java/com/forta/chat/plugins/calls/CallActivity.kt",
            "android/app/src/main/java/com/forta/chat/plugins/calls/CallActivity.kt",
        ).map { File(it) }.first { it.exists() }.readText()
        val start = source.indexOf("fun handleCallConnected()")
        assertTrue(start >= 0)
        val body = source.substring(start, source.indexOf("handler.post(timerRunnable)", start))
        assertTrue(body.contains("if (isConnected) return@runOnUiThread"))
    }
}
