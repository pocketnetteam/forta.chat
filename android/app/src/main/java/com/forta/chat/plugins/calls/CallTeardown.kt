package com.forta.chat.plugins.calls

import android.content.Context
import android.media.AudioManager
import android.util.Log

/**
 * The one native owner of "this call is over" — see [CallTeardownPolicy] for
 * the rules. Every end-of-call hook that can run without the JS finalize
 * (`CallConnection.onReject` / `onDisconnect`, the push-delivered hangup, the
 * plugin's cold start) calls [endCall]; the policy decides whether anything is
 * left to release, and this object applies it.
 *
 * Safe to call from any thread: the router serialises its lifecycle on its own
 * lock, and a running foreground service accepts a stop intent from the
 * background. Every step is wrapped so one failure cannot skip the next.
 */
object CallTeardown {
    private const val TAG = "CallTeardown"

    fun endCall(context: Context, reason: CallTeardownPolicy.Reason, callId: String?) {
        CallHangupSignal.forget(callId)
        val app = context.applicationContext
        val state = try {
            collectState(app, callId)
        } catch (t: Throwable) {
            Log.w(TAG, "endCall reason=$reason callId=$callId — could not read device state", t)
            return
        }
        val actions = CallTeardownPolicy.decide(reason, state, callId)
        Log.i(TAG, "endCall reason=$reason callId=$callId $state actions=$actions")
        for (action in actions) {
            runCatching {
                when (action) {
                    CallTeardownPolicy.Action.STOP_RINGER ->
                        IncomingRinger.stop(state.ringingCallId)
                    CallTeardownPolicy.Action.FORCE_STOP_ROUTER ->
                        AudioRouter.getSharedInstance(app).forceStop("teardown $reason")
                    CallTeardownPolicy.Action.STOP_FOREGROUND_SERVICE ->
                        CallForegroundService.stop(app, callId)
                }
            }.onFailure { Log.w(TAG, "endCall reason=$reason: $action threw", it) }
        }
        // A fresh process has no session of ours open. Whatever the previous
        // one left behind is settled now — acted on above, or not ours to act
        // on — and a marker kept past this point could later claim another
        // app's live call as a stranded mode of ours.
        if (reason == CallTeardownPolicy.Reason.COLD_START) {
            AudioRouter.clearSessionMarker(app)
        }
    }

    private fun collectState(app: Context, callId: String?): CallTeardownPolicy.State {
        val audioManager = app.getSystemService(Context.AUDIO_SERVICE) as AudioManager
        // The mode getter is documented to throw on a few privacy-shield ROMs;
        // an unknown mode simply never counts as "stuck in VoIP mode".
        val mode = runCatching { audioManager.mode }.getOrNull()
        val slot = CallConnectionService.currentConnection
        return CallTeardownPolicy.State(
            audioMode = mode,
            // A slot keyed by a push event id ($…) can never match a Matrix
            // call id; treating it as "another call" used to skip the router
            // force-stop and leave the device in a call audio mode.
            otherCallLive = slot != null && (callId == null || !CallSlotPolicy.owns(slot.callId, callId)),
            foregroundServiceRunning = CallForegroundService.isRunning,
            routerActive = AudioRouter.getSharedInstance(app).isRoutingActive(),
            sessionMarkerOpen = AudioRouter.hasOpenSessionMarker(app),
            ringingCallId = IncomingRinger.ringingCallId,
            routerOwnerCallId = AudioRouter.getSharedInstance(app).routingOwner(),
        )
    }
}
