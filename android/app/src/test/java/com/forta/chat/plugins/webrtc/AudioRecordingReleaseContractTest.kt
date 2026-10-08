package com.forta.chat.plugins.webrtc

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Pins how [NativeWebRTCManager] hands the microphone back when a call's last
 * connection closes. Source-level, like [TrackAttachContractTest]: the path runs
 * through a PeerConnectionFactory and the device's audio input.
 *
 * On a Samsung SM-A528B (2026-09-11) an outgoing call nobody answered kept
 * `WebRtcAudioRecordExternal` recording after `pc.close()`: `startRecording` came
 * at HAVE_LOCAL_OFFER and no `stopRecording` followed, so the mic stayed held with
 * no call until the process died. A connection that reached STABLE stops the
 * recorder inside close(). `setAudioRecording(false)` stops the audio device module
 * whatever state the connection is in, but the switch is shared by every
 * connection from the factory, so each new connection raises it again.
 */
class AudioRecordingReleaseContractTest {

    private val mainRoot: File by lazy {
        listOf("src/main/java", "android/app/src/main/java").map { File(it) }.firstOrNull { it.isDirectory }
            ?: error("main sources not found from ${File(".").absolutePath}")
    }

    private val manager by lazy {
        File(mainRoot, "com/forta/chat/plugins/webrtc/NativeWebRTCManager.kt").readText()
    }

    @Test
    fun closingTheLastConnection_stopsRecording_beforeClose() {
        val body = functionBody(manager, "fun\\s+closePeerConnection\\s*\\(")
        val remove = body.indexOf("peerConnections.remove(peerId)")
        val stop = Regex("if\\s*\\(\\s*peerConnections\\.isEmpty\\(\\)\\s*\\)\\s*stopAudioRecording\\(pc, peerId\\)")
            .find(body)?.range?.first ?: -1
        val close = body.indexOf("pc.close()")
        assertTrue("the last connection must stop recording:\n$body", stop >= 0)
        assertTrue("the emptiness check must follow the remove:\n$body", remove in 0 until stop)
        assertTrue("recording must stop before close():\n$body", stop < close)
    }

    @Test
    fun closingAll_stopsRecording_beforeTheFirstClose() {
        val locked = Regex("fun\\s+closeAllPeerConnections\\s*\\([^)]*\\)\\s*=\\s*synchronized\\(mediaLock\\)")
        assertTrue("closeAllPeerConnections must stay under mediaLock", locked.containsMatchIn(manager))
        val body = functionBody(manager, "private\\s+fun\\s+closeAllPeerConnectionsLocked\\s*\\(")
        val stop = body.indexOf("stopAudioRecording(")
        val close = body.indexOf(".close()")
        assertTrue("closing every connection must stop recording:\n$body", stop >= 0)
        assertTrue("recording must stop before the first close():\n$body", stop < close)
    }

    @Test
    fun onlyTheTwoHelpers_flipTheSharedSwitch() {
        val stop = functionBody(manager, "private\\s+fun\\s+stopAudioRecording\\s*\\(")
        val enable = functionBody(manager, "private\\s+fun\\s+enableAudioRecording\\s*\\(")
        assertTrue("stop:\n$stop", stop.contains(".setAudioRecording(false)"))
        assertTrue("enable:\n$enable", enable.contains(".setAudioRecording(true)"))
        val rest = manager.replace(stop, "").replace(enable, "")
        assertFalse(
            "every other switch flip must go through the helpers:\n" +
                rest.lines().filter { it.contains(".setAudioRecording(") }.joinToString("\n"),
            rest.contains(".setAudioRecording("),
        )
    }

    @Test
    fun everyNewConnection_raisesRecordingAgain_beforeTracksAttach() {
        val body = functionBody(manager, "fun\\s+createPeerConnection\\s*\\(")
        val register = body.indexOf("peerConnections[peerId] = pc")
        val enable = body.indexOf("enableAudioRecording(pc, peerId)")
        val attach = body.indexOf("attachLocalTrackLocked(")
        assertTrue("a new connection must raise recording again:\n$body", enable >= 0)
        assertTrue("raise it for the registered connection:\n$body", register in 0 until enable)
        assertTrue("raise it before local tracks attach:\n$body", enable < attach)
        // CallForegroundService's media-release worker runs closeAllPeerConnections
        // while the next call can be setting up. Unlocked, the raise could land
        // between that worker's snapshot and its stop, and the new call, left out
        // of the snapshot, would keep a lowered switch and go out silent.
        val lock = body.indexOf("synchronized(mediaLock)")
        assertTrue("raise it under mediaLock, like closeAll's stop:\n$body", lock in (register + 1) until enable)
    }

    @Test
    fun onlyTheManagerCreatesConnectionsFromTheFactory() {
        // A connection created past NativeWebRTCManager.createPeerConnection would
        // skip enableAudioRecording and go out silent after any call that stopped it.
        val call = Regex("(\\w+)\\??\\.createPeerConnection\\(")
        val calls = mainRoot.walkTopDown()
            .filter { it.isFile && it.extension in setOf("kt", "java") }
            .flatMap { file -> call.findAll(file.readText()).map { "${file.name}:${it.groupValues[1]}" } }
            .toList()
        val direct = calls.filterNot { it.endsWith(":mgr") || it.endsWith(":manager") }
        assertEquals("createPeerConnection calls: $calls", listOf("NativeWebRTCManager.kt:factory"), direct)
    }

    // -- helpers --------------------------------------------------------------

    private fun functionBody(src: String, signaturePattern: String): String {
        val match = Regex("$signaturePattern[^{]*\\{").find(src)
            ?: error("Could not find /$signaturePattern/ in source")
        return braceBody(src, match.range.last + 1)
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
