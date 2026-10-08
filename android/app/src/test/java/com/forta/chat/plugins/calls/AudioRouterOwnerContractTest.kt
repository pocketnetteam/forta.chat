package com.forta.chat.plugins.calls

import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Pins the C02 wiring (calls review 2026-10-04): the router remembers which
 * call owns it, a new call takes it over even while the previous stop is
 * queued, and the plugin passes the JS callId through both directions.
 * The rule itself is unit-tested in [AudioRouterOwnershipTest].
 */
class AudioRouterOwnerContractTest {

    private fun source(relative: String): String {
        val candidates = listOf("src/main/java/$relative", "android/app/src/main/java/$relative")
        return candidates.map { File(it) }.firstOrNull { it.exists() }?.readText()
            ?: error("$relative not found. Tried: $candidates from ${File(".").absolutePath}")
    }

    private val router by lazy { source("com/forta/chat/plugins/calls/AudioRouter.kt") }
    private val plugin by lazy { source("com/forta/chat/plugins/calls/CallPlugin.kt") }

    private fun body(text: String, signature: String): String {
        val start = Regex(signature).find(text)?.range?.first ?: error("no $signature")
        val next = Regex("\\n    (private |internal )?fun ").find(text, start + 1)?.range?.first ?: text.length
        return text.substring(start, next)
    }

    @Test
    fun startTakesOwnership_evenWhenAlreadyActive() {
        val start = body(router, "fun start\\(callType: String, callId: String\\? = null\\)")
        val active = start.indexOf("if (isActive)")
        val handover = start.indexOf("AudioRouterOwnership.ownerAfterStart(ownerCallId, callId)")
        assertTrue("the already-active branch must hand the router to the new call:\n$start", handover > active && active >= 0)
        assertTrue("a fresh start records its owner", start.contains("this.ownerCallId = callId"))
    }

    @Test
    fun stopForAnotherCall_isDropped() {
        val stop = body(router, "fun stop\\(callId: String\\? = null\\): Boolean")
        val guard = stop.indexOf("AudioRouterOwnership.shouldStop(callId, ownerCallId)")
        val teardown = stop.indexOf("stopRouting()")
        assertTrue("the owner check must run before the teardown:\n$stop", guard in 0 until teardown)
    }

    @Test
    fun forceStop_clearsTheOwner() {
        assertTrue(body(router, "fun forceStop\\(").contains("ownerCallId = null"))
    }

    @Test
    fun plugin_passesTheCallIdBothWays() {
        assertTrue(body(plugin, "fun startAudioRouting\\(").contains("audioRouter?.start(callType, call.getString(\"callId\"))"))
        val stop = body(plugin, "fun stopAudioRouting\\(")
        assertTrue("stopAudioRouting must hand the callId to the router:\n$stop", stop.contains("audioRouter?.stop(callId)"))
        assertTrue("a dropped stop must not unbind the volume rocker:\n$stop", stop.indexOf("if (!stopped)") in 0 until stop.indexOf("USE_DEFAULT_STREAM_TYPE"))
    }
}
