package com.forta.chat.plugins.webrtc

import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Pins the N1 wiring (Samsung run 2026-10-08): both closes of an ended call —
 * the JS finalize's step through [WebRTCPlugin] and the call service's
 * media-release worker — carry the moment the call ended, and the manager
 * keeps a connection created after it, with its listener and recording.
 * The rule itself is unit-tested in [ReleaseScopePolicyTest].
 */
class ReleaseScopeContractTest {

    private fun source(relative: String): String {
        val candidates = listOf("src/main/java/$relative", "android/app/src/main/java/$relative")
        return candidates.map { File(it) }.firstOrNull { it.exists() }?.readText()
            ?: error("$relative not found. Tried: $candidates from ${File(".").absolutePath}")
    }

    private val manager by lazy { source("com/forta/chat/plugins/webrtc/NativeWebRTCManager.kt") }
    private val plugin by lazy { source("com/forta/chat/plugins/webrtc/WebRTCPlugin.kt") }
    private val service by lazy { source("com/forta/chat/plugins/calls/CallForegroundService.kt") }

    private fun body(text: String, signature: String): String {
        val start = Regex(signature).find(text)?.range?.first ?: error("no $signature")
        val next = Regex("\\n    (private |internal |override )?fun ").find(text, start + 1)?.range?.first ?: text.length
        return text.substring(start, next)
    }

    @Test
    fun everyConnection_recordsWhenItWasCreated() {
        val create = body(manager, "fun createPeerConnection\\(")
        val stamp = create.indexOf("peerCreatedAt[peerId] = System.currentTimeMillis()")
        val register = create.indexOf("peerConnections[peerId] = pc")
        assertTrue("createPeerConnection must stamp the connection before registering it:\n$create", stamp in 0 until register)
    }

    @Test
    fun theClose_takesOnlyWhatTheEndedCallCreated() {
        val close = body(manager, "private fun closeAllPeerConnectionsLocked\\(")
        assertTrue(close, close.contains("ReleaseScopePolicy.closes(peerCreatedAt[peerId], createdBefore)"))
        assertTrue("a closed connection must leave the map one by one, never by clear():\n$close", !close.contains("peerConnections.clear()"))
    }

    @Test
    fun aKeptConnection_keepsItsListenerAndRecording() {
        val close = body(manager, "private fun closeAllPeerConnectionsLocked\\(")
        val emptyBranch = close.indexOf("if (kept.isEmpty())")
        val branchReturn = close.indexOf("return", emptyBranch)
        val listenerCleared = close.indexOf("listener = null")
        assertTrue("the listener may go only when nothing is kept:\n$close", listenerCleared in emptyBranch until branchReturn)
        assertTrue("recording must be raised again for the kept connections:\n$close", close.contains("for ((peerId, pc) in kept) enableAudioRecording(pc, peerId)"))
        val detach = close.indexOf("detachLocalTracksLocked(pc, peerId)")
        val dispose = close.indexOf("stopLocalMediaLocked()", branchReturn)
        assertTrue("the ended call's tracks must come off a kept connection before they are disposed:\n$close", detach in 0 until dispose)
    }

    @Test
    fun theJsFinalize_passesWhenTheCallEnded() {
        val close = body(plugin, "fun closeAllPeerConnections\\(call: PluginCall\\)")
        assertTrue(close, close.contains("manager?.closeAllPeerConnections(call.getLong(\"createdBefore\"))"))
    }

    @Test
    fun theServiceWorker_closesOnlyWhatExistedWhenTheStopWasAskedFor() {
        val stop = body(service, "fun stop\\(context: Context")
        assertTrue("stop() must stamp the request:\n$stop", stop.contains("putExtra(EXTRA_STOP_REQUESTED_AT, System.currentTimeMillis())"))
        assertTrue("ACTION_STOP must keep the stamp", service.contains("stopRequestedAt = intent.getLongExtra(EXTRA_STOP_REQUESTED_AT"))
        val release = body(service, "private fun releaseMediaAsync\\(")
        val mark = release.indexOf("val createdBefore = stopRequestedAt ?: System.currentTimeMillis()")
        val execute = release.indexOf("mediaReleaseExecutor.execute")
        assertTrue("the mark must be taken when the release is scheduled, not when the worker runs:\n$release", mark in 0 until execute)
        assertTrue(release, release.contains("closeAllPeerConnections(createdBefore)"))
    }
}
