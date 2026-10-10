package com.forta.chat.plugins.calls

import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Pins C09 (calls review 2026-10-04): a dismissal posted for call A must not
 * close the incoming screen after a queued intent rebound it to call B, so the
 * ownership check runs inside the posted runnable, not only before posting.
 */
class IncomingScreenOwnershipContractTest {

    private fun source(relative: String): String {
        val candidates = listOf("src/main/java/$relative", "android/app/src/main/java/$relative")
        return candidates.map { File(it) }.firstOrNull { it.exists() }?.readText()
            ?: error("$relative not found. Tried: $candidates from ${File(".").absolutePath}")
    }

    private val activity by lazy { source("com/forta/chat/plugins/calls/IncomingCallActivity.kt") }

    private fun body(signature: String): String {
        val start = Regex(signature).find(activity)?.range?.first ?: error("no $signature")
        val next = Regex("\\n        fun |\\n    (private |override )?fun ").find(activity, start + 1)?.range?.first ?: activity.length
        return activity.substring(start, next)
    }

    @Test
    fun remoteHangup_rechecksOwnershipInsideThePostedRunnable() {
        val dismiss = body("fun dismissIfShowing\\(")
        val post = dismiss.indexOf("handler.post {")
        val recheck = dismiss.indexOf("RemoteHangupPolicy.endsSurface(screen.shownCallId, endedCallId)", post)
        val close = dismiss.indexOf("screen.dismissByRemote()", post)
        assertTrue("the owner check must run inside the runnable, before the close:\n$dismiss", post >= 0 && recheck in post until close)
    }

    @Test
    fun answeredElsewhere_closesOnlyTheScreenItSaw() {
        val stop = body("fun stopRingerIfShowing\\(")
        val post = stop.indexOf("handler.post {")
        val guard = stop.indexOf("RemoteHangupPolicy.endsSurface(screen.shownCallId, answeredCallId)", post)
        val finish = stop.indexOf("screen.finish()", post)
        assertTrue("the rebound check must run inside the runnable, before finish():\n$stop", post >= 0 && guard in post until finish)
    }

    @Test
    fun answeredElsewhere_stopsOnlyTheAnsweredCallsRing() {
        // Review 2026-10-08: stopAll() here silenced call B's ring and retired
        // its deadline when the answer for call A arrived after the screen was
        // rebound to B.
        val stop = body("fun stopRingerIfShowing\\(")
        assertTrue("the ring must be stopped by the answered call's id:\n$stop", stop.contains("RemoteHangupPolicy.endsSurface(it, answeredCallId)"))
        assertTrue("no blanket stop of whatever rings:\n$stop", !stop.contains("stopAll()"))
    }

    @Test
    fun bothAnswerRoutes_nameTheAnsweredCall() {
        val connection = source("com/forta/chat/plugins/calls/CallConnection.kt")
        val plugin = source("com/forta/chat/plugins/calls/CallPlugin.kt")
        assertTrue("CallConnection.onAnswer must name its call", connection.contains("IncomingCallActivity.stopRingerIfShowing(callId)"))
        assertTrue("reportCallConnected must name its call", plugin.contains("IncomingCallActivity.stopRingerIfShowing(callId)"))
        assertTrue("no unnamed caller left", !connection.contains("stopRingerIfShowing()") && !plugin.contains("stopRingerIfShowing()"))
    }
}
