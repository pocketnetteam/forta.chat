package com.forta.chat.plugins.calls

import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.OutcomeReceiver
import android.os.SystemClock
import java.util.concurrent.atomic.AtomicReference
import android.telecom.*
import android.util.Log
import androidx.annotation.RequiresApi
import java.util.concurrent.atomic.AtomicBoolean

class CallConnection(
    private val context: Context,
    val callId: String,
    val roomId: String = ""
) : Connection() {

    companion object {
        /**
         * All three carry the room as well as the id.
         *
         * `onAnswered` used to carry only the id, and its listener read the
         * room out of `CallConnection.pendingAnswer` — a global that belongs to
         * whichever call last wrote one. On the path where the activity answers
         * without a Telecom connection, the marker for THIS call is written a
         * few statements later, so the listener could pair the tapped call's id
         * with a previous call's room and arm the JS answer wait against it.
         */
        var onAnswered: ((String, String) -> Unit)? = null
        /**
         * The id alone does not always identify the call: a connection created
         * from a push is keyed by the push payload's `call_id`, which this
         * homeserver fills with the event_id, so it can never equal the Matrix
         * callId JS holds. With the room JS can at least refuse an event that
         * belongs somewhere else.
         */
        var onRejected: ((String, String) -> Unit)? = null
        var onEnded: ((String, String) -> Unit)? = null

        /**
         * "The user answered / declined before JS was running" markers, read
         * once by CallPlugin.getPendingAnswer / getPendingReject.
         *
         * Written from the main thread (Telecom callbacks, IncomingCallActivity)
         * and read from Capacitor's plugin thread, exactly like
         * [currentConnection] above — hence the atomic holders. They also have
         * to move as a unit: the callId and roomId name one call, and the JS
         * matcher ages the room-scoped branch out by the write time, so a
         * half-updated pair could offer a stale room as freshly marked. See
         * [PendingCallMarker].
         *
         * Note the id stored here is really the push `event_id` — pocketnet's
         * homeserver does not put Matrix's `content.call_id` in the payload —
         * so the JS consumer correlates by room too.
         */
        private val pendingAnswerRef = AtomicReference(PendingCallMarker.NONE)
        private val pendingRejectRef = AtomicReference(PendingCallMarker.NONE)

        var pendingAnswer: PendingCallMarker
            get() = pendingAnswerRef.get()
            set(value) = pendingAnswerRef.set(value)

        var pendingReject: PendingCallMarker
            get() = pendingRejectRef.get()
            set(value) = pendingRejectRef.set(value)

        /** Reads the marker and clears it in one step, so a concurrent write cannot be lost. */
        fun takePendingAnswer(): PendingCallMarker =
            pendingAnswerRef.getAndSet(PendingCallMarker.NONE)

        /** @see takePendingAnswer */
        fun takePendingReject(): PendingCallMarker =
            pendingRejectRef.getAndSet(PendingCallMarker.NONE)

        /**
         * Belt-and-braces write for the paths where Telecom never ran (a region
         * that rate-limits addNewIncomingCall, say, or a call it refused as
         * BUSY because this app already holds one): defers to the
         * authoritative marker for the same call and replaces one another call
         * left standing. See [PendingCallMarker.seeded].
         */
        fun seedPendingAnswer(marker: PendingCallMarker) {
            pendingAnswerRef.updateAndGet { PendingCallMarker.seeded(it, marker) }
        }

        /** @see seedPendingAnswer */
        fun seedPendingReject(marker: PendingCallMarker) {
            pendingRejectRef.updateAndGet { PendingCallMarker.seeded(it, marker) }
        }

        /**
         * Retires both markers for a call JS has finished with.
         *
         * A marker only carries a decision across a process that was not alive
         * to act on it. Once JS has finalized the call it has acted, and
         * anything left behind reaches the next invite from that room through
         * the roomId fallback: a queued answer picks it up with no ringer at
         * all, a queued reject declines it unheard. Both were seen on the
         * bench (Samsung SM-A528B, 2026-09-09).
         *
         * Matched on callId OR roomId, and the room is the load-bearing half:
         * a connection created from a push is keyed by the push's call_id,
         * which this homeserver fills with the event_id, so it can never equal
         * the Matrix callId a finalize carries. On the push path — the primary
         * ringer surface — callId alone would retire nothing.
         *
         * [roomId] arrives only when JS can vouch that no other call it knows
         * about is live in that room, so this can never erase a marker a newer
         * call still needs. JS owns that judgement because only it knows which
         * calls it is handling.
         */
        fun retirePendingMarkersForCall(callId: String?, roomId: String?) {
            pendingAnswerRef.updateAndGet { it.clearedFor(callId, roomId) }
            pendingRejectRef.updateAndGet { it.clearedFor(callId, roomId) }
        }

        /**
         * The answer half of [retirePendingMarkersForCall], for a surface that
         * is declining rather than finishing: the accept marker for this call
         * must go, and the reject marker is the thing being recorded.
         *
         * Scoped like the pair above and for the same reason — the ringer is
         * routinely on screen for a different call than the one whose answer
         * is queued, so "drop every accept marker" throws away a decision the
         * user already made on another call.
         */
        fun retirePendingAnswerForCall(callId: String?, roomId: String?) {
            pendingAnswerRef.updateAndGet { it.clearedFor(callId, roomId) }
        }

        /**
         * Backstop for a connection nobody ever resolves. Longer than the 30 s
         * deadline in [IncomingRinger] so that, when the ringer does run, its
         * own auto-reject still wins and the user keeps the UI they are
         * looking at. Shorter than the SDK's 60 s invite lifetime, so the
         * device is never left ringing for a call the caller has given up on.
         */
        const val RING_TIMEOUT_MS = 45_000L

        /**
         * How long an answer Telecom delivered natively may wait for JS to
         * report the call connected before the connection is released.
         *
         * `onAnswer` cancels the ring timeout, so without this nothing bounds an
         * answered connection whose JS never comes: a headset press on a call
         * swiped away while ringing left one ACTIVE until a force-stop (Samsung,
         * 2026-09-13). Long enough for a cold start from push: JS answers within
         * the SDK's 60 s invite lifetime or not at all, and the extra 30 s
         * covers connecting after a late answer — the slowest bench cold start
         * had sound 30 s after the tap.
         */
        const val ANSWER_ADOPTION_TIMEOUT_MS = 90_000L
    }

    /**
     * When this connection started ringing, on the monotonic clock. Read by
     * [StaleCallPolicy] on app resume as the second net behind
     * [armRingTimeout] — see that method for why one timer is not enough.
     */
    @Volatile
    var ringingSinceMs: Long = SystemClock.elapsedRealtime()
        private set

    private val ringTimeoutHandler = Handler(Looper.getMainLooper())
    private val ringTimeoutRunnable = Runnable {
        Log.w("CallConnection", "Ring timeout — no answer or decline reached us, rejecting $callId")
        // Nothing catches a throw out of a main-looper Runnable: it kills the
        // process. onReject is guarded against a double teardown, but Telecom
        // can still throw from a state it did not expect, and this timer fires
        // unattended — the user is not even holding the phone.
        runCatching { onReject() }
            .onFailure { Log.w("CallConnection", "ring timeout reject threw", it) }
    }

    /**
     * `SystemClock.elapsedRealtime()` when Telecom answered this connection,
     * null until then. Read by [StaleCallPolicy.isUnadoptedAnswer] on app
     * resume as the second net behind [adoptionTimeoutRunnable].
     */
    @Volatile
    var answeredAtMs: Long? = null
        private set

    /**
     * JS reported this call connected. Written from Capacitor's plugin thread,
     * read by the backstop on the main looper.
     */
    @Volatile
    var adoptedByJs: Boolean = false
        private set

    /** Releases an answer JS never picked up. See [ANSWER_ADOPTION_TIMEOUT_MS]. */
    private val adoptionTimeoutRunnable = Runnable {
        if (adoptedByJs) return@Runnable
        Log.w("CallConnection", "Answered call was never picked up by JS — releasing $callId")
        // onDisconnect, never onReject: the caller gave up long ago, and a reject
        // marker can only ever decline something later. Caught for the same
        // reason as the ring timeout: this fires with nobody holding the phone.
        runCatching { onDisconnect() }
            .onFailure { Log.w("CallConnection", "adoption timeout release threw", it) }
    }

    /**
     * Latched once the connection has been disconnected, so teardown runs once.
     *
     * Atomic because the writers are on different threads: the ring backstop
     * fires on the main looper, while the stale-ring sweep reaches
     * [releaseStaleRingingConnection] from Capacitor's plugin thread. Both are
     * keyed to the same 45 s deadline, so them landing together is routine, not
     * exotic — and a plain check-then-set would let both pass the guard and
     * transition an already-destroyed connection, which Telecom answers with a
     * throw.
     */
    private val released = AtomicBoolean(false)

    /**
     * Start the no-answer backstop.
     *
     * Telecom holds the device in MODE_RINGTONE for as long as this connection
     * lives, and the only timer that used to end it lived inside
     * [IncomingCallActivity]. That activity does not always run — a blocked
     * full-screen intent never starts it — and when it does run, a back press
     * or a swipe from Recents destroys it, and its cleanup *cancels* the
     * auto-reject without replacing it. Either way the connection stayed
     * RINGING and the phone's media volume stayed broken until reboot. This
     * timer lives with the connection instead, so it survives both.
     */
    fun armRingTimeout() {
        ringingSinceMs = SystemClock.elapsedRealtime()
        ringTimeoutHandler.removeCallbacks(ringTimeoutRunnable)
        ringTimeoutHandler.postDelayed(ringTimeoutRunnable, RING_TIMEOUT_MS)
    }

    private fun cancelRingTimeout() {
        ringTimeoutHandler.removeCallbacks(ringTimeoutRunnable)
    }

    /**
     * Start the backstop for an answer JS has to pick up. Armed by [onAnswer]
     * only: a call JS answers itself is connected by JS, and an outgoing call is
     * never answered here.
     */
    private fun armAdoptionTimeout() {
        answeredAtMs = SystemClock.elapsedRealtime()
        ringTimeoutHandler.removeCallbacks(adoptionTimeoutRunnable)
        ringTimeoutHandler.postDelayed(adoptionTimeoutRunnable, ANSWER_ADOPTION_TIMEOUT_MS)
    }

    private fun cancelAdoptionTimeout() {
        ringTimeoutHandler.removeCallbacks(adoptionTimeoutRunnable)
    }

    /**
     * JS reported this call connected, so the answer has been picked up.
     *
     * The flag goes first: the backstop reads it, so a deadline already
     * dequeued on the main looper still sees the adoption.
     */
    fun markAdoptedByJs() {
        adoptedByJs = true
        cancelAdoptionTimeout()
    }

    /**
     * The endpoints Telecom last offered this call (API 34+). A route request
     * has to name one of them; see [requestAudioRoute]. Written by Telecom's
     * callback on the main thread, read from whichever thread picks a route.
     */
    @Volatile
    private var availableEndpoints: List<CallEndpoint> = emptyList()

    /**
     * Ask Telecom to move this call's audio to [device].
     *
     * Telecom owns the route of a self-managed call. On a Samsung with
     * Android 14, AudioRouter's setCommunicationDevice was recorded and ignored
     * through 16 speaker picks, while Telecom's own switch to a headset was the
     * only change anyone heard (stage 3, 2026-09-13). API 34 takes an endpoint
     * Telecom offered; before that, for a Bluetooth headset (see
     * [TelecomAudioRoute.viaCallEndpoint]), or when none of the offered endpoints
     * matches, the route constant.
     *
     * @return false when this connection can no longer carry a request.
     */
    fun requestAudioRoute(device: AudioRouter.Device): Boolean {
        if (released.get()) return false
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE && TelecomAudioRoute.viaCallEndpoint(device)) {
            val type = TelecomAudioRoute.endpointTypeFor(device)
            val endpoint = availableEndpoints.firstOrNull { it.endpointType == type }
            if (endpoint != null) {
                requestCallEndpointChange(
                    endpoint,
                    context.mainExecutor,
                    object : OutcomeReceiver<Void, CallEndpointException> {
                        override fun onResult(result: Void?) {
                            Log.d("CallConnection", "requestCallEndpointChange($device): done")
                        }

                        override fun onError(error: CallEndpointException) {
                            Log.w("CallConnection", "requestCallEndpointChange($device) failed: code=${error.code}")
                        }
                    },
                )
                return true
            }
        }
        // Self-managed connections, the only kind this app creates, are
        // Android 8+; nothing to route through Telecom below it.
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return false
        Log.d("CallConnection", "setAudioRoute($device)")
        @Suppress("DEPRECATION")
        setAudioRoute(TelecomAudioRoute.routeFor(device))
        return true
    }

    @RequiresApi(Build.VERSION_CODES.UPSIDE_DOWN_CAKE)
    override fun onAvailableCallEndpointsChanged(availableEndpoints: List<CallEndpoint>) {
        this.availableEndpoints = availableEndpoints
    }

    /** Telecom's route report on API 34+; see [AudioRouter.onTelecomRouteChanged]. */
    @RequiresApi(Build.VERSION_CODES.UPSIDE_DOWN_CAKE)
    override fun onCallEndpointChanged(callEndpoint: CallEndpoint) {
        val device = TelecomAudioRoute.deviceForEndpointType(callEndpoint.endpointType) ?: return
        Log.d("CallConnection", "onCallEndpointChanged: $callId -> $device")
        AudioRouter.getSharedInstance(context).onTelecomRouteChanged(device)
    }

    /** Telecom's route report before API 34; see [AudioRouter.onTelecomRouteChanged]. */
    @Deprecated("Telecom reports routes through onCallEndpointChanged on API 34+")
    override fun onCallAudioStateChanged(state: CallAudioState) {
        // API 34 delivers the same change through both callbacks; mirroring it
        // twice would ask a pinned loudspeaker back twice.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) return
        val device = TelecomAudioRoute.deviceForRoute(state.route) ?: return
        Log.d("CallConnection", "onCallAudioStateChanged: $callId -> $device")
        AudioRouter.getSharedInstance(context).onTelecomRouteChanged(device)
    }

    /**
     * Telecom's "stop ringing" (API 29+). While a self-managed call rings, the
     * system takes a volume-key press for silenceRinger and forwards it here;
     * the key never reaches IncomingCallActivity, so its volumeControlStream
     * cannot act. Silence only: the ringer screen stays up, and both deadlines
     * (the ringer's 30 s and this connection's backstop) still end an
     * unanswered call on time.
     */
    override fun onSilence() {
        Log.d("CallConnection", "onSilence: callId=$callId")
        IncomingRinger.silence()
    }

    override fun onAnswer() {
        Log.d("CallConnection", "onAnswer: callId=$callId, roomId=$roomId")
        cancelRingTimeout()
        // Symmetric to onReject/onDisconnect: Telecom throws when a destroyed
        // connection is transitioned again. The ring backstop makes that
        // reachable by a hair's breadth — it fires on the same main looper the
        // Accept button posts to, so a tap landing just after the deadline used
        // to take the process down with it.
        if (released.get()) {
            Log.w("CallConnection", "onAnswer: connection already released, ignoring")
            return
        }
        setActive()
        armAdoptionTimeout()
        // Every answer route reaches this method — the activity's own Accept
        // button calls it, and so does Telecom when it answers on its own from a
        // Bluetooth headset, Android Auto or the system call UI. Silencing here
        // is what covers the Telecom routes, which never touch the activity and
        // used to leave its looping ringtone playing over the connected call
        // until the 30 s auto-reject hung it up. Idempotent for the Accept path,
        // which has already run cleanup().
        IncomingRinger.stop(callId)
        IncomingCallActivity.stopRingerIfShowing(callId)
        CallConnectionService.dismissIncomingCallNotification(context)
        // The push-side notification keeps its own Accept/Decline buttons; a
        // Decline tapped on it during the call would hang the call up.
        if (roomId.isNotEmpty()) {
            runCatching {
                com.forta.chat.FortaFirebaseMessagingService.dismissPushCallNotification(context, roomId)
            }
        }
        // Populate accept-only markers here, never in onCreateIncoming-
        // Connection — otherwise Decline and a plain push delivery
        // would also set them and JS would fast-path into an in-call
        // screen the user never asked for.
        pendingAnswer = PendingCallMarker.of(callId, roomId, System.currentTimeMillis())
        if (onAnswered != null) {
            onAnswered?.invoke(callId, roomId)
        } else {
            Log.w("CallConnection", "onAnswer: JS listener not wired, queued for replay")
        }
    }

    override fun onReject() {
        Log.d("CallConnection", "onReject: callId=$callId, roomId=$roomId")
        cancelRingTimeout()
        cancelAdoptionTimeout()
        // Telecom throws if a destroyed connection is disconnected again, and
        // there are now several routes here — the button, the shade action, the
        // activity's countdown and this connection's own backstop.
        if (!released.compareAndSet(false, true)) {
            Log.d("CallConnection", "onReject: already released, skipping teardown")
            return
        }
        setDisconnected(DisconnectCause(DisconnectCause.REJECTED))
        destroy()
        CallConnectionService.dismissIncomingCallNotification(context)
        // A reject here ends the call as surely as a remote hangup: an invite push
        // the frozen page reads afterwards must not ring it again (`dualb6`, the
        // ring timed out and the phone rang a second time). reportIncomingCall and
        // the push path both consult the store.
        if (callId.isNotEmpty()) {
            runCatching { CancelledCallStore(context).markCancelled(callId) }
                .onFailure { Log.w("CallConnection", "could not mark $callId cancelled", it) }
        }
        // Wipe any stale accept markers so a late-arriving MatrixCall
        // for this room can't trigger the JS fast-path to auto-answer.
        clearPendingFor(callId, roomId)
        // Queue the reject so that when the JS app eventually boots
        // (or is already running) it can send m.call.reject to Matrix
        // and the caller stops ringing.
        // Vacate the single global slot. Nothing used to clear it, so after
        // any call ended `currentConnection` still pointed at a destroyed
        // Connection — and every later reader (the stale-ring sweep, the
        // displacement check above it) was inspecting a corpse. Identity-
        // guarded so a connection that was already displaced by a newer one
        // cannot blank its successor's slot.
        if (CallConnectionService.currentConnection === this) {
            CallConnectionService.currentConnection = null
        }
        // Ends a process left with nothing to present — see IdleProcessExit.
        IdleProcessExit.schedule(context, "reject $callId")
        // Backstop for the paths that never reach the JS finalize (ring timeout
        // with a frozen WebView, a Telecom-side reject); a no-op when JS has
        // already torn the audio session down. Wrapped so it can never keep the
        // reject from reaching JS.
        runCatching { CallTeardown.endCall(context, CallTeardownPolicy.Reason.REJECT, callId) }
            .onFailure { Log.w("CallConnection", "teardown after reject threw", it) }
        pendingReject = PendingCallMarker.of(callId, roomId, System.currentTimeMillis())
        onRejected?.invoke(callId, roomId)
    }

    override fun onDisconnect() {
        Log.d("CallConnection", "onDisconnect: $callId")
        cancelRingTimeout()
        cancelAdoptionTimeout()
        if (!released.compareAndSet(false, true)) {
            Log.d("CallConnection", "onDisconnect: already released, skipping teardown")
            return
        }
        setDisconnected(DisconnectCause(DisconnectCause.LOCAL))
        destroy()
        CallConnectionService.dismissIncomingCallNotification(context)
        // Vacate the single global slot. Nothing used to clear it, so after
        // any call ended `currentConnection` still pointed at a destroyed
        // Connection — and every later reader (the stale-ring sweep, the
        // displacement check above it) was inspecting a corpse. Identity-
        // guarded so a connection that was already displaced by a newer one
        // cannot blank its successor's slot.
        if (CallConnectionService.currentConnection === this) {
            CallConnectionService.currentConnection = null
        }
        // Ends a process left with nothing to present — see IdleProcessExit.
        IdleProcessExit.schedule(context, "disconnect $callId")
        clearPendingFor(callId, roomId)
        // Backstop for the disconnects JS never drives: a headset or the
        // system call UI ending the call, a push-delivered hangup while the
        // WebView is frozen in the background. The policy skips the global
        // teardown when a newer call already owns the slot (displacement) and
        // when JS has already stopped the router (the normal hangup).
        runCatching { CallTeardown.endCall(context, CallTeardownPolicy.Reason.DISCONNECT, callId) }
            .onFailure { Log.w("CallConnection", "teardown after disconnect threw", it) }
        onEnded?.invoke(callId, roomId)
    }

    /**
     * Answer marker only, matched on either key, run natively at teardown.
     * Not to be confused with the companion's
     * [CallConnection.retirePendingMarkersForCall], which retires BOTH markers
     * on JS's behalf once it has finalized a call, and bounds its room match
     * by time. This one stays: it is the backstop for the path where JS is
     * dead or wedged and no finalize will ever come.
     */
    private fun clearPendingFor(cid: String, rid: String) {
        // Answer markers only, as before: we are declining, so a pending
        // accept for this call must go, while a pending reject is the thing
        // being recorded. Either key identifies the call, so a match on one
        // drops the marker whole — clearing just the matching half used to
        // strand the other.
        pendingAnswerRef.updateAndGet { it.clearedFor(cid, rid) }
    }
}
