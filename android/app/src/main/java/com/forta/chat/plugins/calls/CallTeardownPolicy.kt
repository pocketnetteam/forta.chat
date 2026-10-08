package com.forta.chat.plugins.calls

import android.media.AudioManager

/**
 * Decides what a call ending has to clean up, given how the device looks at
 * that moment.
 *
 * Nine native places used to decide "the call is over" on their own, and none
 * of them was obliged to release everything: the audio mode, the foreground
 * service and the Telecom slot each had a different set of writers, and the
 * paths that skipped the JS finalize (a push-delivered hangup, a Telecom
 * disconnect from a headset, a process that died mid-call) left the device in
 * `MODE_IN_COMMUNICATION` until reboot — the largest cluster of open call
 * reports. [CallTeardown] runs this policy from every native end-of-call hook
 * so the decision lives in one place, and this object stays free of Android
 * services so the rules are unit-testable.
 *
 * Two rules do the real work:
 *
 *  - Nothing global is touched while a *different* call still owns the slot.
 *    Displacing a stale connection at the start of the next call ends the old
 *    one through the same hook, and tearing the router down then would silence
 *    the call that is just starting.
 *  - Global teardown runs only on evidence the audio session was abandoned:
 *    the router still active, or the persisted session marker still open with
 *    the device in VoIP mode. On the normal path JS has already stopped the
 *    router and closed the marker before the Telecom hook fires, so the policy
 *    is a no-op there and never stops the foreground service a step early.
 *
 * `MODE_RINGTONE` and `MODE_IN_CALL` are never reset: the system ringer and a
 * cellular call set them too, and the only honest way out of a stuck ringtone
 * mode is releasing our own Telecom connection (see [StaleCallPolicy]).
 */
object CallTeardownPolicy {

    enum class Reason {
        /** Our Telecom connection was rejected (button, shade, ring timeout). */
        REJECT,
        /** Our Telecom connection was disconnected (JS hangup, headset, displacement). */
        DISCONNECT,
        /** A push-delivered hangup/reject arrived and there was no connection to end. */
        REMOTE_HANGUP,
        /** The plugin loaded in a fresh process; a previous one may have died mid-call. */
        COLD_START,
    }

    enum class Action {
        /** `IncomingRinger.stop` — silence the ringtone/vibration and retire the 30 s deadline. */
        STOP_RINGER,
        /** `AudioRouter.forceStop` — restore `MODE_NORMAL`, clear routing, close the marker. */
        FORCE_STOP_ROUTER,
        /** `CallForegroundService.stop` — drop the ongoing-call notification and wake-lock. */
        STOP_FOREGROUND_SERVICE,
    }

    data class State(
        /** `AudioManager.mode`, or null when the getter threw (documented on some OEM ROMs). */
        val audioMode: Int?,
        /** The Telecom slot holds a connection for a call other than the one ending. */
        val otherCallLive: Boolean,
        val foregroundServiceRunning: Boolean,
        val routerActive: Boolean,
        /** Persisted "audio session open" marker written by the router on start. */
        val sessionMarkerOpen: Boolean,
        /** The call `IncomingRinger` is ringing for, or null when silent. */
        val ringingCallId: String? = null,
        /** The call `AudioRouter` routes for (C02), or null when nobody owns it. */
        val routerOwnerCallId: String? = null,
    )

    /**
     * [callId] is the call that ended, when the hook knows it. The ringer is
     * stopped for that call only: a Telecom reject of one call must not
     * silence the ring of the call that displaced it, and a push hangup for a
     * call that already ended must not silence the next one. A push without
     * call_id names only its own event, and the cold-start sweep names no
     * call at all, so those stop whatever rings.
     */
    fun decide(reason: Reason, state: State, callId: String? = null): List<Action> {
        val actions = mutableListOf<Action>()
        val ringing = state.ringingCallId
        if (ringing != null && stopsRing(reason, ringing, callId)) actions.add(Action.STOP_RINGER)
        if (state.otherCallLive) return actions
        // C02, native half (review 2026-10-08): the next call may hold the
        // router without a Telecom slot of its own; a late teardown of this
        // call must not reset that call's audio.
        if (reason != Reason.COLD_START && routerOwnedByAnotherCall(state.routerOwnerCallId, callId)) return actions
        val abandoned = state.routerActive ||
            (state.sessionMarkerOpen && state.audioMode == AudioManager.MODE_IN_COMMUNICATION)
        if (!abandoned) return actions
        actions.add(Action.FORCE_STOP_ROUTER)
        if (state.foregroundServiceRunning) actions.add(Action.STOP_FOREGROUND_SERVICE)
        return actions
    }

    /**
     * Both ids known, comparable and different. A push event id never equals
     * a Matrix call id, so it proves nothing (see [CallSlotPolicy]).
     */
    private fun routerOwnedByAnotherCall(owner: String?, callId: String?): Boolean {
        if (owner.isNullOrEmpty() || callId.isNullOrEmpty()) return false
        if (CallSlotPolicy.isEventId(owner) || CallSlotPolicy.isEventId(callId)) return false
        return owner != callId
    }

    private fun stopsRing(reason: Reason, ringing: String, callId: String?): Boolean = when (reason) {
        Reason.REJECT, Reason.DISCONNECT -> callId.isNullOrEmpty() || callId == ringing
        Reason.REMOTE_HANGUP -> RemoteHangupPolicy.endsSurface(ringing, callId)
        Reason.COLD_START -> true
    }
}
