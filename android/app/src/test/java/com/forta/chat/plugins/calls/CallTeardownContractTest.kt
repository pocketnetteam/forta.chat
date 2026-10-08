package com.forta.chat.plugins.calls

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Pins the wiring of [CallTeardown] into every native end-of-call hook and the
 * removal of the ownerless audio-mode writes. Source-level assertions in the
 * spirit of [CallForegroundServiceDestroyContractTest]: exercising Telecom,
 * Firebase and Capacitor lifecycles would need hosts and fakes far more
 * brittle than the contract itself.
 */
class CallTeardownContractTest {

    private fun source(relative: String): String {
        val candidates = listOf("src/main/java/$relative", "android/app/src/main/java/$relative")
        val resolved = candidates.map { File(it) }.firstOrNull { it.exists() }
            ?: error("$relative not found. Tried: $candidates from ${File(".").absolutePath}")
        return resolved.readText()
    }

    private val connectionService by lazy { (source("com/forta/chat/plugins/calls/CallConnectionService.kt") + "\n" + source("com/forta/chat/plugins/calls/CallConnection.kt")) }
    private val foregroundService by lazy { source("com/forta/chat/plugins/calls/CallForegroundService.kt") }
    private val firebaseService by lazy { source("com/forta/chat/FortaFirebaseMessagingService.kt") }
    private val callPlugin by lazy { source("com/forta/chat/plugins/calls/CallPlugin.kt") }
    private val callActivity by lazy { source("com/forta/chat/plugins/calls/CallActivity.kt") }
    private val webrtcManager by lazy { source("com/forta/chat/plugins/webrtc/NativeWebRTCManager.kt") }
    private val audioRouter by lazy { source("com/forta/chat/plugins/calls/AudioRouter.kt") }

    // -- Telecom hooks -------------------------------------------------------

    @Test
    fun onReject_runsTheTeardown_afterVacatingTheSlot() {
        val body = functionBody(connectionService, "override\\s+fun\\s+onReject\\s*\\(")
        val vacate = body.indexOf("currentConnection = null")
        val teardown = body.indexOf("CallTeardown.endCall(")
        assertTrue("onReject must call CallTeardown.endCall:\n$body", teardown >= 0)
        assertTrue("teardown must run after the slot is vacated:\n$body", vacate in 0 until teardown)
        assertTrue(body.contains("Reason.REJECT"))
    }

    @Test
    fun onDisconnect_runsTheTeardown_beforeTellingJs() {
        val body = functionBody(connectionService, "override\\s+fun\\s+onDisconnect\\s*\\(")
        val vacate = body.indexOf("currentConnection = null")
        val teardown = body.indexOf("CallTeardown.endCall(")
        val notify = body.indexOf("onEnded?.invoke(")
        assertTrue("onDisconnect must call CallTeardown.endCall:\n$body", teardown >= 0)
        assertTrue("teardown must run after the slot is vacated:\n$body", vacate in 0 until teardown)
        assertTrue("teardown must run before JS is notified:\n$body", teardown < notify)
        assertTrue(body.contains("Reason.DISCONNECT"))
    }

    @Test
    fun telecomHooks_wrapTheTeardown_soItCannotBlockTheCallback() {
        for (name in listOf("onReject", "onDisconnect")) {
            val body = functionBody(connectionService, "override\\s+fun\\s+$name\\s*\\(")
            val call = body.indexOf("CallTeardown.endCall(")
            val guard = body.lastIndexOf("runCatching", call)
            assertTrue("$name: teardown must sit inside runCatching:\n$body", guard >= 0 && call - guard < 120)
        }
    }

    // -- Push-delivered hangup ------------------------------------------------

    @Test
    fun remoteHangup_resolvesTheEndedCallId_beforeTouchingTheSlot() {
        val block = hangupBlock()
        val id = block.indexOf("val endedCallId")
        val disconnect = block.indexOf(".onDisconnect()")
        assertTrue("endedCallId must be resolved first:\n$block", id in 0 until disconnect)
    }

    @Test
    fun remoteHangup_runsTheTeardown_whenThereWasNoConnectionToEnd() {
        val block = hangupBlock()
        assertTrue(block.contains("CallTeardown.endCall("))
        assertTrue(block.contains("Reason.REMOTE_HANGUP"))
        assertTrue(
            "teardown must be the fallback for a missing connection:\n$block",
            block.contains("if (!disconnectedConnection)"),
        )
    }

    // -- Foreground service ---------------------------------------------------

    @Test
    fun actionStop_releasesTheRouterAndLiveness_withoutWaitingForOnDestroy() {
        val block = braceBlock(foregroundService, "ACTION_STOP -> {")
        val guard = block.indexOf("isSuperseded()")
        val forceStop = block.indexOf(".forceStop(")
        assertTrue("ACTION_STOP must force-stop the router:\n$block", forceStop >= 0)
        assertTrue("ACTION_STOP must guard on isSuperseded() first:\n$block", guard in 0 until forceStop)
        assertTrue("ACTION_STOP must clear instance:\n$block", block.contains("instance = null"))
        assertTrue("ACTION_STOP must still stopSelf():\n$block", block.contains("stopSelf()"))
    }

    @Test
    fun actionStop_ignoresAStopIssuedForAnEarlierStart() {
        // The redial race: the previous call's stop lands after the next
        // call's start. Nothing in the stop body may run for a stale stop —
        // least of all the router reset, which would silence the new call.
        val block = braceBlock(foregroundService, "ACTION_STOP -> {")
        val guard = block.indexOf("CallServiceStopPolicy.isStale(")
        val forceStop = block.indexOf(".forceStop(")
        assertTrue("ACTION_STOP must check the start generation first:\n$block", guard in 0 until forceStop)
        assertTrue(
            "the stale branch must return before any teardown:\n$block",
            block.substring(guard, forceStop).contains("return START_NOT_STICKY"),
        )
        assertTrue(
            "stop() must carry the generation it was issued against",
            functionBody(foregroundService, "fun\\s+stop\\s*\\(").contains("EXTRA_GENERATION"),
        )
        assertTrue(
            "start() must bump the generation synchronously, before the intent is sent",
            functionBody(foregroundService, "fun\\s+start\\s*\\(").contains("startGeneration.incrementAndGet()"),
        )
    }

    @Test
    fun actionStart_reassertsLiveness_soAReusedInstanceReadsAsRunning() {
        // ACTION_STOP clears `instance`; Android reuses the same Service
        // object for a start that arrives before the deferred destroy, and
        // only onCreate used to set the field.
        val block = braceBlock(foregroundService, "ACTION_START -> {")
        assertTrue("ACTION_START must set instance = this:\n$block", block.contains("instance = this"))
    }

    // -- Cold start -----------------------------------------------------------

    @Test
    fun pluginLoad_sweepsTheModeLeftByADeadProcess() {
        val body = functionBody(callPlugin, "override\\s+fun\\s+load\\s*\\(")
        assertTrue("load() must run the cold-start teardown:\n$body", body.contains("CallTeardown.endCall("))
        assertTrue(body.contains("Reason.COLD_START"))
    }

    @Test
    fun coldStartSweep_settlesTheMarker_whetherOrNotItActed() {
        val body = functionBody(source("com/forta/chat/plugins/calls/CallTeardown.kt"), "fun\\s+endCall\\s*\\(")
        val clear = body.indexOf("AudioRouter.clearSessionMarker(")
        assertTrue("endCall must clear the marker on COLD_START:\n$body", clear >= 0)
        val guard = body.lastIndexOf("Reason.COLD_START", clear)
        assertTrue("the clear must be gated on COLD_START:\n$body", guard >= 0 && clear - guard < 80)
    }

    @Test
    fun stop_onAnInactiveRouter_closesTheMarker() {
        // The inactive branch used to return without touching anything; a
        // marker opened by ensureCommunicationMode() and never closed would
        // later pass the cold-start sweep's "is this mode ours" check for a
        // mode that is not.
        val body = functionBody(audioRouter, "fun\\s+stop\\s*\\(")
        val inactiveReturn = body.indexOf("already inactive, no-op")
        val close = body.lastIndexOf("markSessionClosed()", inactiveReturn)
        assertTrue("stop()'s inactive branch must close the marker before returning:\n$body", close >= 0 && inactiveReturn - close < 400)
    }

    // -- Single owner of the VoIP mode ---------------------------------------

    @Test
    fun onlyTheRouterWritesModeInCommunication() {
        val directWrite = Regex("\\.mode\\s*=\\s*AudioManager\\.MODE_IN_COMMUNICATION")
        assertFalse(
            "NativeWebRTCManager must go through AudioRouter.ensureCommunicationMode",
            directWrite.containsMatchIn(webrtcManager),
        )
        assertFalse(
            "CallActivity must go through AudioRouter.ensureCommunicationMode",
            directWrite.containsMatchIn(callActivity),
        )
        assertTrue(webrtcManager.contains("ensureCommunicationMode("))
        assertTrue(callActivity.contains("ensureCommunicationMode("))
        assertTrue(directWrite.containsMatchIn(audioRouter))
    }

    @Test
    fun ensureCommunicationMode_neverClaimsAnActiveRouter() {
        // start() is idempotent on isActive; flipping it here would make the
        // real start() skip its device selection and callbacks.
        val body = functionBody(audioRouter, "fun\\s+ensureCommunicationMode\\s*\\(")
        assertFalse("ensureCommunicationMode must not set isActive:\n$body", body.contains("isActive = true"))
        assertTrue(body.contains("markSessionOpen()"))
    }

    @Test
    fun sessionMarker_isClosedByBothTeardownPaths() {
        for (name in listOf("stop", "forceStop")) {
            val body = functionBody(audioRouter, "fun\\s+$name\\s*\\(")
            assertTrue("$name() must close the session marker:\n$body", body.contains("markSessionClosed()"))
        }
    }

    // -- helpers --------------------------------------------------------------

    private fun hangupBlock(): String {
        val start = firebaseService.indexOf("msgType == \"m.call.hangup\"")
        val end = firebaseService.indexOf("// Handle calls", start)
        require(start >= 0 && end > start) { "hangup branch not found in FortaFirebaseMessagingService.kt" }
        return firebaseService.substring(start, end)
    }

    private fun functionBody(src: String, signaturePattern: String): String {
        val match = Regex("$signaturePattern[^{]*\\{").find(src)
            ?: error("Could not find /$signaturePattern/ in source")
        return braceBody(src, match.range.last + 1)
    }

    private fun braceBlock(src: String, opener: String): String {
        val at = src.indexOf(opener)
        require(at >= 0) { "Could not find '$opener' in source" }
        return braceBody(src, at + opener.length)
    }

    /** Brace-counted body starting just after an opening brace. */
    private fun braceBody(src: String, start: Int): String {
        var depth = 1
        var i = start
        while (i < src.length && depth > 0) {
            when (src[i]) {
                '{' -> depth++
                '}' -> depth--
            }
            i++
        }
        return src.substring(start, i - 1)
    }
}
