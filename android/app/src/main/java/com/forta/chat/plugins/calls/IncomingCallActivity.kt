package com.forta.chat.plugins.calls

import android.animation.AnimatorSet
import android.animation.ObjectAnimator
import android.app.Activity
import android.app.KeyguardManager
import android.content.Context
import android.content.Intent
import android.os.Build
import android.media.AudioManager
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import android.view.WindowManager
import android.view.animation.AccelerateDecelerateInterpolator
import android.util.Log
import android.widget.ImageButton
import android.widget.LinearLayout
import android.widget.TextView
import com.forta.chat.FortaFirebaseMessagingService
import com.forta.chat.MainActivity
import com.forta.chat.R
import com.forta.chat.plugins.locale.LocaleHelper
import com.forta.chat.utils.WindowInsetsHelper

class IncomingCallActivity : Activity() {

    override fun attachBaseContext(newBase: Context) {
        super.attachBaseContext(LocaleHelper.wrapContext(newBase))
    }

    companion object {
        private const val TAG = "IncomingCallActivity"

        /** Static reference so FCM service can dismiss on call cancel/hangup */
        var currentInstance: IncomingCallActivity? = null

        /**
         * A call ended somewhere else. [endedCallId] is that call when the
         * caller knows it: the ring and this screen come down only if they
         * belong to it, so a late hangup for an earlier call leaves the next
         * one ringing (see [RemoteHangupPolicy]). Without an id whatever rings
         * and shows comes down.
         */
        fun dismissIfShowing(endedCallId: String? = null) {
            IncomingRinger.ringingCallId
                ?.takeIf { RemoteHangupPolicy.endsSurface(it, endedCallId) }
                ?.let { IncomingRinger.stop(it) }
            currentInstance?.takeIf { RemoteHangupPolicy.endsSurface(it.shownCallId, endedCallId) }?.let {
                Log.d(TAG, "Dismissing incoming call screen (remote hangup)")
                it.handler.post { it.dismissByRemote() }
            }
        }

        /**
         * The call was answered somewhere other than this screen's Accept
         * button — Telecom on its own (a Bluetooth headset, Android Auto, the
         * system call UI) or the JS side reporting the connect. Stop the ring
         * and take this screen down. The ringtone, the vibration and the 30 s
         * deadline live in [IncomingRinger], so this works even when the
         * instance that armed them is no longer the one [currentInstance]
         * points at; a covered activity gets onPause/onStop but never
         * onDestroy, which is how the old instance-owned ringer kept playing
         * over a connected call and hung it up at second 30.
         *
         * Unlike [dismissIfShowing] this deliberately leaves the pending-answer
         * markers alone: they are how the JS side learns to answer, and an
         * answered call is exactly when they are needed.
         */
        fun stopRingerIfShowing() {
            // The ringer is process-wide now, so this silences it even when the
            // instance that armed it is no longer the one the pointer holds.
            IncomingRinger.stopAll()
            currentInstance?.let {
                Log.d(TAG, "Call answered elsewhere — silencing ringer")
                it.handler.post {
                    it.cleanup()
                    it.finish()
                }
            }
        }
    }

    private var pulseAnimator: AnimatorSet? = null

    private val handler = Handler(Looper.getMainLooper())
    private var countdownSeconds = (IncomingRinger.AUTO_REJECT_TIMEOUT_MS / 1000).toInt()

    /** callId whose identity is currently painted on screen — see [onNewIntent]. */
    private var shownCallId: String = ""

    private val countdownRunnable = object : Runnable {
        override fun run() {
            countdownSeconds--
            findViewById<TextView>(R.id.countdown_text)?.text = "${countdownSeconds}s"
            if (countdownSeconds > 0) {
                handler.postDelayed(this, 1000)
            }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Started from the app's card in Recents: the task kept the intent of a
        // call that is over. Open the app instead of ringing for it.
        if (RingerRelaunchPolicy.isFromRecents(intent.flags)) {
            Log.i(TAG, "onCreate: relaunched from Recents for ${intent.getStringExtra("callId")} — opening the app")
            runCatching {
                startActivity(Intent(this, MainActivity::class.java).apply {
                    flags = Intent.FLAG_ACTIVITY_NEW_TASK or
                        Intent.FLAG_ACTIVITY_CLEAR_TOP or
                        Intent.FLAG_ACTIVITY_SINGLE_TOP
                })
            }.onFailure { Log.w(TAG, "Failed to open MainActivity on a Recents relaunch", it) }
            finish()
            return
        }
        currentInstance = this
        // O13: the volume rocker on this screen must change the ringer, not
        // media — the ringtone plays on STREAM_RING, and a user turning a
        // loud ring down was adjusting the wrong stream.
        volumeControlStream = AudioManager.STREAM_RING

        // Session 41: now that the FCM service posts the FSI notification
        // unconditionally, both the channel ringtone and the activity's
        // own startRingtone() would otherwise play in parallel. Dismiss
        // the FSI as soon as the activity has surfaced — the activity
        // itself is now the sole ringer source. Idempotent if it was
        // never posted (no-op cancel).
        intent.getStringExtra("roomId")?.let { rId ->
            safeStep("dismissPushFsi") {
                FortaFirebaseMessagingService.dismissPushCallNotification(this, rId)
            }
        }

        // H1: action extra from notification accept/decline PendingIntents.
        // The accept/decline actions attached to the CallStyle notification
        // launch this Activity with `action=accept|decline`; we must NOT
        // render the ringer UI and instead dispatch immediately. Without
        // this the user tapped Accept in the shade, saw the full ringer
        // appear again, and had to tap Accept a second time.
        val action = intent.getStringExtra("action")
        if (action == "accept" || action == "decline") {
            Log.d(TAG, "onCreate: auto-dispatching action=$action, skipping UI")
            // Suppress the default Activity animation because we finish
            // immediately — a visible flash of empty content is jarring.
            safeStep("overridePendingTransitionForAction") { overridePendingTransition(0, 0) }
            try {
                if (action == "accept") accept() else decline()
            } catch (t: Throwable) {
                Log.e(TAG, CallCrashGuard.marker("action=$action dispatch"), t)
                runCatching { finish() }
            }
            return
        }

        // WEE-31: every step below is a known crash-point on at least one
        // device family — OEM lockscreen overrides (Xiaomi/MIUI), missing
        // layout resources on legacy WebViews, edge-to-edge inset access
        // pre-Android-11, etc. Wrapping the whole body in a try/catch
        // turns a process-death "наглухо" crash into a logged stacktrace
        // + a graceful finish so the user can retry the call. Each
        // critical step is also wrapped in safeStep so the exact failing
        // step is identifiable in logcat for future investigation.
        try {
            // Show on lock screen
            safeStep("setLockScreenFlags") {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
                    setShowWhenLocked(true)
                    setTurnScreenOn(true)
                    val keyguardManager = getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager
                    keyguardManager.requestDismissKeyguard(this, null)
                } else {
                    @Suppress("DEPRECATION")
                    window.addFlags(
                        WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or
                            WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON or
                            WindowManager.LayoutParams.FLAG_DISMISS_KEYGUARD,
                    )
                }
                window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            }

            safeStep("setContentView") {
                setContentView(R.layout.activity_incoming_call)
            }

            // Apply real system bar insets instead of hardcoded 80dp margin
            safeStep("setupEdgeToEdge") {
                WindowInsetsHelper.setupEdgeToEdge(
                    activity = this,
                    onInsets = { _, bottom, _, _ ->
                        val buttonsContainer = findViewById<LinearLayout>(R.id.buttons_container)
                            ?: return@setupEdgeToEdge
                        val lp = buttonsContainer.layoutParams as? LinearLayout.LayoutParams
                            ?: return@setupEdgeToEdge
                        lp.bottomMargin = bottom + (32 * resources.displayMetrics.density).toInt()
                        buttonsContainer.layoutParams = lp
                    },
                )
            }

            val callerName = intent.getStringExtra("callerName") ?: "Unknown"
            val hasVideo = intent.getBooleanExtra("hasVideo", false)

            // Bind views (every findViewById can be null if the inflated
            // layout is missing the resource — vendor themes that override
            // attribute resolution have historically nulled view bindings
            // here without throwing in setContentView).
            safeStep("bindViews") {
                shownCallId = intent.getStringExtra("callId") ?: ""
                bindCallerIdentity(callerName, hasVideo)
                findViewById<TextView>(R.id.countdown_text)?.text = "${countdownSeconds}s"

                // Buttons
                findViewById<ImageButton>(R.id.btn_accept)?.setOnClickListener {
                    tryStep("accept") { accept() }
                }
                findViewById<ImageButton>(R.id.btn_decline)?.setOnClickListener {
                    tryStep("decline") { decline() }
                }
            }

            // Ringtone, vibration and the 30 s no-answer deadline live in the
            // process-wide ringer, keyed by this call — see IncomingRinger.
            safeStep("startRinger") { IncomingRinger.arm(this, shownCallId) { autoDecline() } }

            // Start pulse animation
            safeStep("startPulseAnimation") { startPulseAnimation() }

            // The countdown is display only; the deadline itself is the ringer's.
            handler.postDelayed(countdownRunnable, 1000)
        } catch (t: Throwable) {
            Log.e(TAG, "[callee-crash-guard] onCreate failed — finishing gracefully", t)
            // Surface a reject to the caller so they stop ringing, then
            // dismiss everything and finish. Without this the caller would
            // see "ringing" for ~30-60s until their own SDK timeout fires.
            runCatching {
                rejectRingingConnection(intent.getStringExtra("callId") ?: "")
                CallConnectionService.dismissIncomingCallNotification(this)
                intent.getStringExtra("roomId")?.let { rId ->
                    FortaFirebaseMessagingService.dismissPushCallNotification(this, rId)
                }
                cleanup()
                finish()
            }
        }
    }

    /**
     * Run [block], log any throwable with the named step prefix, and
     * rethrow. The outer onCreate try/catch then turns it into a graceful
     * finish; logcat still has the exact failing step (WEE-31).
     */
    /**
     * Swallowing counterpart of [safeStep], for work that runs *after*
     * onCreate has returned.
     *
     * onCreate's steps are wrapped by a rethrowing guard because an outer
     * catch there can still finish the activity gracefully. A click listener
     * has no such outer frame: anything that escapes it reaches the looper
     * and kills the process — with the user's finger still on the Accept
     * button of a call that then never connects.
     */
    private inline fun tryStep(step: String, block: () -> Unit) {
        CallCrashGuard.tryStep(
            step = step,
            fallback = Unit,
            onFailure = { failedStep, error ->
                Log.e(TAG, CallCrashGuard.marker(failedStep), error)
            },
            block = block,
        )
    }

    private inline fun safeStep(step: String, block: () -> Unit) {
        CallCrashGuard.safeStep(
            step = step,
            onFailure = { failedStep, error ->
                Log.e(TAG, CallCrashGuard.marker(failedStep), error)
            },
            block = block,
        )
    }

    /**
     * Re-dispatch action extras when the system delivers a new Intent to
     * an already-resident instance.
     *
     * The notification's Accept / Decline action buttons (added in the
     * FCM service for WEE-18) launch this Activity with
     * launchMode="singleTop", so when the ringer is already visible the
     * tap arrives via onNewIntent rather than a fresh onCreate. Without
     * this override the action= extra would be silently ignored and the
     * shade button would behave like a no-op (#751 backslide path).
     */
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        // A shade Accept/Decline from the Telecom notification carries no
        // roomId; taking it as-is used to drop the room this ringer was
        // opened for. Fill what the new intent lacks from the one we hold —
        // for the same call only (IncomingIntentMerge).
        val merged = IncomingIntentMerge.merge(extrasOf(this.intent), extrasOf(intent))
        intent.putExtra("callId", merged.callId)
        merged.callerName?.let { intent.putExtra("callerName", it) }
        merged.roomId?.let { intent.putExtra("roomId", it) }
        merged.hasVideo?.let { intent.putExtra("hasVideo", it) }
        setIntent(intent)

        val action = intent.getStringExtra("action")
        if (action == "accept" || action == "decline") {
            Log.d(TAG, "onNewIntent: dispatching action=$action on resident instance")
            // WEE-31: mirror the onCreate action-dispatch guard. Without
            // this, a throw inside accept()/decline() — e.g. Android 12+
            // startActivity background-start restriction blocking the
            // MainActivity boot — would propagate uncaught out of
            // onNewIntent into the system Activity thread and process-
            // kill the callee, defeating the entire crash-guard PR.
            try {
                if (action == "accept") accept() else decline()
            } catch (t: Throwable) {
                Log.e(TAG, CallCrashGuard.marker("action=$action onNewIntent dispatch"), t)
                runCatching { finish() }
            }
            return
        }

        // A *second* caller reaching a ringer that is already up: a redial from
        // the same room, or a ringing call whose room is unknown — a caller from
        // another room is kept off this screen by SecondRingPolicy. setIntent()
        // above has already swapped what accept()/decline() will act on, so the
        // visible identity has to follow — otherwise the user sees the first
        // caller's name and answers the second one's call. Telecom does not
        // release the first call for this: it refuses the second registration
        // while the first is RINGING, and the first ends on its own timers.
        val newCallId = intent.getStringExtra("callId") ?: ""
        if (newCallId.isEmpty() || newCallId == shownCallId) return

        // Same reason as the action branch: a throw out of onNewIntent lands on
        // the system Activity thread and process-kills the callee.
        tryStep("rebind-second-call") {
            Log.d(TAG, "onNewIntent: second call $newCallId displacing $shownCallId on screen")
            shownCallId = newCallId
            bindCallerIdentity(
                intent.getStringExtra("callerName") ?: "Unknown",
                intent.getBooleanExtra("hasVideo", false),
            )

            // Restart the deadline rather than letting the new call inherit
            // whatever was left of the old one's — a call arriving at second 29
            // would otherwise be auto-rejected almost on sight. Re-arming the
            // ringer for the new callId retires the old deadline.
            IncomingRinger.arm(this, newCallId) { autoDecline() }
            handler.removeCallbacks(countdownRunnable)
            countdownSeconds = (IncomingRinger.AUTO_REJECT_TIMEOUT_MS / 1000).toInt()
            findViewById<TextView>(R.id.countdown_text)?.text = "${countdownSeconds}s"
            handler.postDelayed(countdownRunnable, 1000)
        }
    }

    /**
     * Reject whatever Telecom connection this ringer is for — but never an
     * established one.
     *
     * FCM launches this activity independently of Telecom, so a ringer can be
     * on screen for a call that `onCreateIncomingConnection` refused as BUSY.
     * Its decline button and its 30-second auto-reject both act on the single
     * global slot with no callId check, so without this guard a stray ringer
     * would hang up the conversation the user is actually having.
     */
    private fun rejectRingingConnection(callId: String) {
        val connection = CallConnectionService.currentConnection ?: return
        if (!DisplacedConnectionPolicy.mayRelease(connection.state)) {
            Log.w(TAG, "decline ignored: slot holds an established call, not this ringer")
            return
        }
        // A stale tap for a call that was displaced must not reject the call
        // that rings now. CallSlotPolicy knows which slot ids are comparable
        // (an empty or push-event-id slot is not).
        if (!CallSlotPolicy.owns(connection.callId, callId)) {
            Log.w(TAG, "decline ignored: slot rings for ${connection.callId}, not $callId")
            return
        }
        connection.onReject()
    }

    private fun bindCallerIdentity(callerName: String, hasVideo: Boolean) {
        findViewById<TextView>(R.id.caller_name)?.text = callerName
        findViewById<TextView>(R.id.call_type)?.text =
            if (hasVideo) getString(R.string.incoming_video_call) else getString(R.string.incoming_audio_call)
        findViewById<TextView>(R.id.avatar_text)?.text = callerName.take(2).uppercase()
    }

    private fun accept() {
        Log.d(TAG, "Accept pressed")
        val callId = intent.getStringExtra("callId") ?: ""
        IncomingRinger.stop(callId)
        cleanup()

        val callerName = intent.getStringExtra("callerName") ?: "Unknown"
        val hasVideo = intent.getBooleanExtra("hasVideo", false)

        // Notify Telecom / JS listener that user tapped Answer. One of
        // two paths fires depending on whether the app process is alive:
        //   - connection.onAnswer() → invokes onAnswered callback (wired
        //     by CallPlugin.load) or queues the pending-answer marker for JS
        //     to pick up later via getPendingAnswer.
        //   - CallConnection.onAnswered direct invoke as fallback when
        //     we bypassed Telecom.
        val slot = CallConnectionService.currentConnection
        // The same shape of guard the decline path carries, and for the same
        // reason: FCM launches this activity independently of Telecom, so it can
        // be on screen for a call `onCreateIncomingConnection` refused as BUSY,
        // and the slot then holds the conversation the user is having.
        // Answering that connection would not answer the call on screen at all
        // — and `onAnswer` would write a fresh pendingAnswer marker for the
        // OTHER call and arm the JS answer wait for its room, which is how a
        // later invite from that room gets picked up with no ringer.
        //
        // The state is what carries this. An id check cannot: CallSlotPolicy
        // treats a slot keyed by a push event id as unkeyed so Telecom can
        // always be ended, and on this homeserver that is the common shape.
        val connection = slot?.takeIf {
            IncomingAcceptPolicy.mayAnswerSlot(it.state, it.callId, callId)
        }
        if (connection != null) {
            // Telecom throws from a state transition on a connection it has
            // already destroyed — which the ring backstop now makes reachable
            // by racing the user's tap. Contained here rather than only at the
            // listener so the pending-answer markers and the app launch below
            // still run: the JS side can then answer the Matrix call even when
            // the Telecom handoff is past saving.
            tryStep("connection.onAnswer") { connection.onAnswer() }
        } else {
            if (slot != null) {
                Log.w(
                    TAG,
                    "accept: slot holds ${slot.callId} in state ${slot.state}, " +
                        "not this ringer's $callId — answering via JS",
                )
            } else {
                Log.w(TAG, "No ConnectionService connection, notifying JS directly")
            }
            // Either way the call the user tapped is the one JS is told about,
            // and it carries its own room — the listener must not have to guess
            // it from a global marker another call may own.
            CallConnection.onAnswered?.invoke(callId, intent.getStringExtra("roomId") ?: "")
        }

        // Belt-and-braces: ensure the pending-answer markers are set on
        // CallConnection even when Telecom integration failed (e.g. a
        // region that rate-limits addNewIncomingCall and never calls
        // onCreateIncomingConnection — we'd have no roomId stashed).
        // JS-side consumePendingAnswerCallId correlates by roomId when
        // the push-side call_id doesn't match the Matrix call.callId,
        // so the roomId in particular must be present.
        val roomIdForPending = intent.getStringExtra("roomId")
        CallConnection.seedPendingAnswer(
            PendingCallMarker.of(callId, roomIdForPending, System.currentTimeMillis()),
        )

        // Launch MainActivity in the FOREGROUND so Capacitor's WebView
        // becomes the resumed activity. Android pauses and eventually
        // stops a WebView's host activity when it's fully covered by
        // another opaque activity (which is what the ealier design did
        // with CallActivity on top + MainActivity in background) — when
        // stopped, the WebView throttles/freezes its JS timers, so the
        // JS call-answer flow doesn't actually run until the user
        // manually returns to the app. Symptom: user tapped Answer but
        // saw "connecting" forever until they switched to the app.
        //
        // By putting MainActivity on top, its onResume fires, the
        // WebView keeps running at full speed, and the JS
        // handleIncomingCall → fast-path → answerCall path completes in
        // the background. As soon as the answer succeeds, the JS side
        // calls NativeWebRTC.launchCallUI, which then pops CallActivity
        // with the "Connecting…" template that transitions to
        // "Connected" on ICE success — same end state as before, just
        // with a short (1-2 sec) Vue loading flicker along the way.
        val appBootIntent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or
                    Intent.FLAG_ACTIVITY_CLEAR_TOP or
                    Intent.FLAG_ACTIVITY_SINGLE_TOP
            putExtra("push_call_accept", true)
            putExtra("callId", callId)
            putExtra("roomId", intent.getStringExtra("roomId"))
        }
        // The only legitimate source of push_call_accept: see KeyguardLiftGate.
        com.forta.chat.KeyguardLiftGate.arm(android.os.SystemClock.elapsedRealtime())
        startActivity(appBootIntent)

        CallConnectionService.dismissIncomingCallNotification(this)
        // Belt-and-braces in case onCreate's dismiss missed (e.g. action=accept
        // path that returned early before the dismiss block, or a race with the
        // notification being re-posted by a retry push). Idempotent.
        intent.getStringExtra("roomId")?.let { rId ->
            FortaFirebaseMessagingService.dismissPushCallNotification(this, rId)
        }
        finish()
    }

    private fun decline() {
        Log.d(TAG, "Decline pressed")
        val callId = intent.getStringExtra("callId") ?: ""
        val wasRinging = IncomingRinger.stop(callId)
        cleanup()

        // A decline reaching a call that is no longer ringing but is live in
        // Telecom is the second-instance bug in person: the orphaned ringer's
        // countdown, or a stale shade button, hanging up the conversation the
        // user is having. Telecom itself is already guarded (rejectRinging-
        // Connection spares an established call); the JS-side reject markers
        // and the decline boot below were not.
        val established = CallConnectionService.currentConnection
            ?.let { !DisplacedConnectionPolicy.mayRelease(it.state) && (it.callId.isEmpty() || it.callId == callId) } == true
        if (!wasRinging && established) {
            Log.w(TAG, "decline ignored: $callId is not ringing and the slot holds an established call")
            CallConnectionService.dismissIncomingCallNotification(this)
            intent.getStringExtra("roomId")?.let { rId ->
                FortaFirebaseMessagingService.dismissPushCallNotification(this, rId)
            }
            finish()
            return
        }

        val roomIdForPending = intent.getStringExtra("roomId")

        // Try ConnectionService — populates CallConnection.pendingReject*.
        // Same containment as accept(): the marker/boot work below is what
        // actually gets the rejection to the caller.
        tryStep("connection.onReject") {
            rejectRingingConnection(callId)
        }

        // Defence-in-depth: clear accept markers (we're declining, not
        // accepting) and set reject markers if Telecom path was bypassed.
        //
        // Scoped to THIS call. A blanket wipe also erased a marker another
        // call was still waiting on, and the reachable case is the one this
        // screen is built for: an answer taken over Bluetooth or the system
        // call UI before JS was running queues a marker for replay, then a
        // second caller's ringer appears over the conversation (Telecom
        // refuses it BUSY, FCM shows it anyway), and declining that one threw
        // away the record of the answer the user had already given. The
        // established-call guard above does not cover it — it compares ids and
        // steps aside for a *different* call by design.
        //
        // By callId alone, for the same reason CallPlugin.reportCallConnected
        // retires that way: every writer of a marker for one call uses that
        // call's own id, and only JS can judge whether a room-wide clear is
        // safe. A marker the Telecom connection wrote under a different id is
        // already retired by its own onReject above.
        //
        // Answer half only: onReject above may have just written the
        // authoritative reject marker, and clearing that here would leave the
        // seed below to rewrite it from this screen's extras instead.
        CallConnection.retirePendingAnswerForCall(callId, null)
        CallConnection.seedPendingReject(
            PendingCallMarker.of(callId, roomIdForPending, System.currentTimeMillis()),
        )

        // Boot the app (in the same way as Accept) so JS can actually
        // send m.call.reject to Matrix once the invite is delivered via
        // /sync. Without this the caller keeps ringing until their own
        // lifetime timeout expires (often 30-60s) — from the user's
        // perspective the Decline button "did nothing".
        try {
            val intent = Intent(this, com.forta.chat.MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or
                    Intent.FLAG_ACTIVITY_CLEAR_TOP or
                    Intent.FLAG_ACTIVITY_SINGLE_TOP
                putExtra("push_call_decline", true)
                putExtra("callId", callId)
                putExtra("roomId", roomIdForPending)
            }
            startActivity(intent)
        } catch (e: Throwable) {
            Log.w(TAG, "Failed to launch MainActivity on decline: $e")
        }

        CallConnectionService.dismissIncomingCallNotification(this)
        intent.getStringExtra("roomId")?.let { rId ->
            FortaFirebaseMessagingService.dismissPushCallNotification(this, rId)
        }
        finish()
    }

    /** Called when remote party cancels/hangs up */
    private fun dismissByRemote() {
        Log.d(TAG, "Remote hangup — dismissing")
        cleanup()
        // Clear accept markers so a stale invite can't re-trigger
        // the JS fast-path after the caller has cancelled — but only for the
        // call this screen was showing. dismissIfShowing() is a blanket
        // "someone hung up", and a blanket clear behind it took out a marker
        // another call was still waiting on.
        CallConnection.retirePendingAnswerForCall(shownCallId, null)
        CallConnectionService.dismissIncomingCallNotification(this)
        intent.getStringExtra("roomId")?.let { rId ->
            FortaFirebaseMessagingService.dismissPushCallNotification(this, rId)
        }
        finish()
    }

    private fun cleanup() {
        handler.removeCallbacks(countdownRunnable)
    }

    /** The ringer's 30 s deadline. It fires only while this call is still ringing. */
    private fun autoDecline() {
        tryStep("auto-decline") { decline() }
    }

    private fun extrasOf(i: Intent?): IncomingCallExtras = IncomingCallExtras(
        callId = i?.getStringExtra("callId") ?: "",
        callerName = i?.getStringExtra("callerName"),
        roomId = i?.getStringExtra("roomId"),
        hasVideo = if (i?.hasExtra("hasVideo") == true) i.getBooleanExtra("hasVideo", false) else null,
        action = i?.getStringExtra("action"),
    )

    private fun startPulseAnimation() {
        val outerRing = findViewById<View>(R.id.pulse_ring_outer) ?: return
        val innerRing = findViewById<View>(R.id.pulse_ring_inner) ?: return

        val outerScaleX = ObjectAnimator.ofFloat(outerRing, "scaleX", 1f, 1.3f, 1f)
        val outerScaleY = ObjectAnimator.ofFloat(outerRing, "scaleY", 1f, 1.3f, 1f)
        val outerAlpha = ObjectAnimator.ofFloat(outerRing, "alpha", 0.15f, 0.0f, 0.15f)

        val innerScaleX = ObjectAnimator.ofFloat(innerRing, "scaleX", 1f, 1.15f, 1f)
        val innerScaleY = ObjectAnimator.ofFloat(innerRing, "scaleY", 1f, 1.15f, 1f)
        val innerAlpha = ObjectAnimator.ofFloat(innerRing, "alpha", 0.25f, 0.1f, 0.25f)

        pulseAnimator = AnimatorSet().apply {
            playTogether(outerScaleX, outerScaleY, outerAlpha, innerScaleX, innerScaleY, innerAlpha)
            duration = 2000
            interpolator = AccelerateDecelerateInterpolator()
            addListener(object : android.animation.AnimatorListenerAdapter() {
                override fun onAnimationEnd(animation: android.animation.Animator) {
                    if (!isFinishing) animation.start()
                }
            })
            start()
        }
    }

    override fun onDestroy() {
        cleanup()
        pulseAnimator?.cancel()
        // Only clear the slot if it still points at us. launchMode=singleTop
        // reuses this activity only while it is on top of the task, and accept()
        // pushes MainActivity above it — so a second incoming call creates a
        // second instance. Clearing unconditionally would let the first
        // instance's onDestroy null out the pointer to the live one, turning
        // dismissIfShowing/stopRingerIfShowing into permanent no-ops and
        // orphaning a ringtone nothing can reach.
        if (currentInstance === this) {
            // A back press or a swipe from Recents: stop ringing, as before.
            // Telecom's own 45 s backstop still ends the connection.
            IncomingRinger.stop(shownCallId)
            currentInstance = null
        }
        super.onDestroy()
    }
}
