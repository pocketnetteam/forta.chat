package com.forta.chat.plugins.calls

import android.media.AudioManager
import android.telecom.Connection

/**
 * Whether the incoming ringer may drop a VoIP audio mode left behind by an
 * earlier call.
 *
 * Android routes the ringtone to the earpiece while the phone is in an in-call
 * audio mode (AOSP `Engine::remapStrategyFromContext`), so a stranded
 * `MODE_IN_COMMUNICATION` makes the next incoming call ring "very quietly at
 * full volume". Telecom covers this for a self-managed RINGING connection by
 * switching to `MODE_RINGTONE`; nothing does when the ringer runs without
 * Telecom (Android 7, a disabled calling account), and that is where the
 * leftover mode was heard (Samsung SM-A528B, 2026-10-13).
 *
 * The reset is `setMode(MODE_NORMAL)` from this process, which withdraws only
 * this process's own mode request: another app's call keeps its mode, and its
 * ring stays quiet by design, and so do a cellular call and Telecom's own
 * `MODE_RINGTONE`.
 */
object RingerModePolicy {

    /** How long a VoIP mode set before routing starts counts as a call being set up. */
    const val SETUP_GRACE_MS = 30_000L

    /**
     * `AudioRouter.ensureCommunicationMode` set the mode for a call that has
     * not started routing yet, recently enough for that call to be alive.
     * Older ensures without a start are what its 5-minute watchdog exists for.
     */
    fun isSettingUp(ensureAtMs: Long?, nowMs: Long): Boolean =
        ensureAtMs != null && nowMs - ensureAtMs in 0 until SETUP_GRACE_MS

    /**
     * Withdraw this process's mode request before the ring when nothing of
     * ours owns it. Withdrawing never touches another app's request, so the
     * current mode does not decide: Android 12+ reports an idle request of
     * ours as `MODE_NORMAL`, and it takes effect again whenever this process
     * captures or plays voice-communication audio.
     */
    fun shouldReleaseModeForRing(routerActive: Boolean, liveCall: Boolean): Boolean =
        !routerActive && !liveCall

    /**
     * Whether the withdrawal dropped a VoIP mode of ours, for the report: the
     * effective mode left `MODE_IN_COMMUNICATION`, or our session marker was
     * still open (a request Android 12+ did not report while idle). A mode that
     * stays `MODE_IN_COMMUNICATION` is another app's call.
     */
    fun droppedStrandedMode(before: Int?, after: Int?, sessionMarkerOpen: Boolean): Boolean {
        if (after == AudioManager.MODE_IN_COMMUNICATION) return false
        return before == AudioManager.MODE_IN_COMMUNICATION || sessionMarkerOpen
    }

    /**
     * A Forta call is still going: the call's foreground service runs (it
     * starts with the call screen, never for a ring), or the Telecom slot
     * holds a connection past ringing. A RINGING slot is the incoming call
     * itself, or a ring it displaces.
     */
    fun isLiveCall(slotState: Int?, foregroundServiceRunning: Boolean): Boolean {
        if (foregroundServiceRunning) return true
        if (slotState == null) return false
        return slotState != Connection.STATE_RINGING && slotState != Connection.STATE_DISCONNECTED
    }

    fun modeName(mode: Int?): String = when (mode) {
        null -> "unknown"
        AudioManager.MODE_NORMAL -> "MODE_NORMAL"
        AudioManager.MODE_RINGTONE -> "MODE_RINGTONE"
        AudioManager.MODE_IN_CALL -> "MODE_IN_CALL"
        AudioManager.MODE_IN_COMMUNICATION -> "MODE_IN_COMMUNICATION"
        else -> "MODE_$mode"
    }

    /** The Telecom slot as the bug report shows it: "none" means the ring runs without Telecom. */
    fun slotLabel(slotState: Int?, isThisCall: Boolean): String {
        if (slotState == null) return "none"
        val state = when (slotState) {
            Connection.STATE_INITIALIZING -> "INITIALIZING"
            Connection.STATE_NEW -> "NEW"
            Connection.STATE_RINGING -> "RINGING"
            Connection.STATE_DIALING -> "DIALING"
            Connection.STATE_ACTIVE -> "ACTIVE"
            Connection.STATE_HOLDING -> "HOLDING"
            Connection.STATE_DISCONNECTED -> "DISCONNECTED"
            else -> "STATE_$slotState"
        }
        return if (isThisCall) state else "$state, another call"
    }
}
