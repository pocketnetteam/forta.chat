package com.forta.chat.plugins.calls

import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Regression: a hangup push handled between the invite push and the ringer / Telecom
 * connection coming up found nothing to dismiss, and the dead call rang for 30-45 s.
 * Both entry points must consult CancelledCallStore before ringing.
 */
class CancelledBeforeRingContractTest {

    private fun source(relative: String): String = listOf(
        "src/main/java/$relative",
        "android/app/src/main/java/$relative",
    ).map { File(it) }.first { it.exists() }.readText()

    @Test
    fun telecomConnectionChecksTheStore() {
        val s = source("com/forta/chat/plugins/calls/CallConnectionService.kt")
        val start = s.indexOf("override fun onCreateIncomingConnection")
        val body = s.substring(start, s.indexOf("currentConnection?.let", start))
        assertTrue(body.contains("CancelledCallStore(this).isCancelled(callId)"))
    }

    @Test
    fun ringerChecksTheStoreBeforeRinging() {
        val s = source("com/forta/chat/plugins/calls/IncomingCallActivity.kt")
        val start = s.indexOf("override fun onCreate(savedInstanceState")
        val body = s.substring(start, s.indexOf("currentInstance = this", start))
        assertTrue(body.contains("CancelledCallStore(this).isCancelled(ringingCallId)"))
    }

    /** Regression: without the full-screen intent the ringer start was assumed to work and the notification skipped. */
    @Test
    fun noFullScreenIntentStillPostsTheNotification() {
        val s = source("com/forta/chat/plugins/calls/CallConnectionService.kt")
        val start = s.indexOf("if (!notificationManager.canUseFullScreenIntent())")
        assertTrue(start >= 0)
        val branch = s.substring(start, s.indexOf("val caller = androidx.core.app.Person.Builder()", start))
        val returns = Regex("^\\s*return\\b", RegexOption.MULTILINE).containsMatchIn(branch)
        assertTrue("the branch must not return before the notification is posted", !returns)
    }
}
