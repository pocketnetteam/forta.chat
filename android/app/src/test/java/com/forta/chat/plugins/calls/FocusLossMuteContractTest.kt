package com.forta.chat.plugins.calls

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Pins the wiring that keeps the microphone open on an outgoing call.
 *
 * `launchCallUI` reaches native before `reportOutgoingCall`, so the call
 * service is granted AUDIOFOCUS_GAIN first; `placeCall` then has Telecom take
 * focus for that same call. The service's listener heard Telecom's focus as an
 * interruption and muted the mic, and focus came back only when Telecom let go
 * at hangup. On a Samsung SM-A528B 4 of 4 outgoing calls went out silent (the
 * peer received ~87 B/s of DTX at energy ~1e-8) while every answered incoming
 * call carried audio — there Telecom already holds focus when the service
 * starts, the request is DELAYED and no loss is ever delivered.
 *
 * The record's own sequence is covered by [FocusLossMuteTest].
 */
class FocusLossMuteContractTest {

    private fun source(relative: String): String {
        val candidates = listOf("src/main/java/$relative", "android/app/src/main/java/$relative")
        return candidates.map { File(it) }.firstOrNull { it.exists() }?.readText()
            ?: error("$relative not found. Tried: $candidates from ${File(".").absolutePath}")
    }

    private val service by lazy { source("com/forta/chat/plugins/calls/CallForegroundService.kt") }
    private val connections by lazy { (source("com/forta/chat/plugins/calls/CallConnectionService.kt") + "\n" + source("com/forta/chat/plugins/calls/CallConnection.kt")) }

    @Test
    fun transientLoss_mutesOnlyWhenNoTelecomCallOwnsTheFocus() {
        val branch = block(service, "AudioManager\\.AUDIOFOCUS_LOSS_TRANSIENT\\s*->")
        assertTrue(
            "the mute must go through the record, keyed on our own Telecom connection:\n$branch",
            branch.contains("focusLossMute.onTransientLoss(") &&
                branch.contains("CallConnectionService.currentConnection != null"),
        )
    }

    @Test
    fun gain_neverUnmutesAMicTheFocusLossDidNotMute() {
        val branch = block(service, "AudioManager\\.AUDIOFOCUS_GAIN\\s*->")
        assertFalse(
            "GAIN must not unmute unconditionally — that overrides a mute the user chose:\n$branch",
            branch.contains("setAudioEnabled(true)"),
        )
        assertTrue(branch.contains("releaseFocusLossMute("))
    }

    @Test
    fun releaseFocusLossMute_unmutesOnlyARecordedFocusLossMute() {
        val body = block(service, "private\\s+fun\\s+releaseFocusLossMute\\s*\\(")
        val gate = body.indexOf("focusLossMute.release()")
        val unmute = body.indexOf("setAudioEnabled(true)")
        assertTrue("the unmute must sit behind the record:\n$body", gate >= 0 && unmute > gate)
    }

    @Test
    fun outgoingConnection_releasesTheMuteTelecomsOwnFocusCaused() {
        val body = block(connections, "override\\s+fun\\s+onCreateOutgoingConnection\\s*\\(")
        val slot = body.indexOf("currentConnection = connection")
        val release = body.indexOf("CallForegroundService.onTelecomTookCall()")
        assertTrue(
            "Telecom's focus loss is delivered before this callback, so the connection must " +
                "release the mute it caused, after taking the slot:\n$body",
            slot >= 0 && release > slot,
        )
    }

    @Test
    fun theRecordLivesUntilTheCallEnds_notUntilTheNextFocusRequest() {
        val abandon = block(service, "private\\s+fun\\s+abandonAudioFocus\\s*\\(")
        assertTrue(
            "the service instance is reused across calls, so ending one must clear the record:\n$abandon",
            abandon.contains("focusLossMute.clear()"),
        )
        val request = block(service, "private\\s+fun\\s+requestAudioFocus\\s*\\(")
        assertFalse(
            "CallActivity.onResume re-requests focus on every return to the call — unlock, PiP " +
                "exit — so clearing the record there would strand a focus-loss mute for the rest " +
                "of the call:\n$request",
            request.contains("focusLossMute"),
        )
    }

    private fun block(src: String, headPattern: String): String {
        val match = Regex("$headPattern[^{]*\\{").find(src)
            ?: error("Could not find /$headPattern/ in source")
        var depth = 1
        var i = match.range.last + 1
        val start = i
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
