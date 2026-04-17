package com.forta.chat.plugins.calls

import android.animation.AnimatorSet
import android.animation.ObjectAnimator
import android.app.Activity
import android.app.KeyguardManager
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.view.View
import android.view.WindowManager
import android.view.animation.AccelerateDecelerateInterpolator
import android.util.Log
import android.widget.ImageButton
import android.widget.LinearLayout
import android.widget.TextView
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
        private const val AUTO_REJECT_TIMEOUT_MS = 30_000L

        /** Static reference so FCM service can dismiss on call cancel/hangup */
        var currentInstance: IncomingCallActivity? = null

        fun dismissIfShowing() {
            currentInstance?.let {
                Log.d(TAG, "Dismissing incoming call screen (remote hangup)")
                it.handler.post { it.dismissByRemote() }
            }
        }
    }

    private var ringtone: android.media.Ringtone? = null
    private var vibrator: Vibrator? = null
    private var pulseAnimator: AnimatorSet? = null

    private val handler = Handler(Looper.getMainLooper())
    private var countdownSeconds = 30

    private val countdownRunnable = object : Runnable {
        override fun run() {
            countdownSeconds--
            findViewById<TextView>(R.id.countdown_text)?.text = "${countdownSeconds}s"
            if (countdownSeconds > 0) {
                handler.postDelayed(this, 1000)
            }
        }
    }

    private val autoRejectRunnable = Runnable {
        decline()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        currentInstance = this

        // Show on lock screen
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
                WindowManager.LayoutParams.FLAG_DISMISS_KEYGUARD
            )
        }
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        setContentView(R.layout.activity_incoming_call)

        // Apply real system bar insets instead of hardcoded 80dp margin
        WindowInsetsHelper.setupEdgeToEdge(
            activity = this,
            onInsets = { _, bottom, _, _ ->
                val buttonsContainer = findViewById<LinearLayout>(R.id.buttons_container)
                val lp = buttonsContainer.layoutParams as LinearLayout.LayoutParams
                lp.bottomMargin = bottom + (32 * resources.displayMetrics.density).toInt()
                buttonsContainer.layoutParams = lp
            }
        )

        val callerName = intent.getStringExtra("callerName") ?: "Unknown"
        val hasVideo = intent.getBooleanExtra("hasVideo", false)

        // Bind views
        findViewById<TextView>(R.id.caller_name).text = callerName
        findViewById<TextView>(R.id.call_type).text =
            if (hasVideo) getString(R.string.incoming_video_call) else getString(R.string.incoming_audio_call)
        findViewById<TextView>(R.id.countdown_text).text = "${countdownSeconds}s"

        // Avatar initials
        val initials = callerName.take(2).uppercase()
        findViewById<TextView>(R.id.avatar_text).text = initials

        // Buttons
        findViewById<ImageButton>(R.id.btn_accept).setOnClickListener { accept() }
        findViewById<ImageButton>(R.id.btn_decline).setOnClickListener { decline() }

        // Start ringtone + vibration
        startRingtone()
        startVibration()

        // Start pulse animation
        startPulseAnimation()

        // Start 30s auto-reject timer
        handler.postDelayed(autoRejectRunnable, AUTO_REJECT_TIMEOUT_MS)
        handler.postDelayed(countdownRunnable, 1000)
    }

    private fun accept() {
        Log.d(TAG, "Accept pressed")
        cleanup()

        val callId = intent.getStringExtra("callId") ?: ""
        val callerName = intent.getStringExtra("callerName") ?: "Unknown"
        val hasVideo = intent.getBooleanExtra("hasVideo", false)

        // Notify Telecom / JS listener that user tapped Answer. One of
        // two paths fires depending on whether the app process is alive:
        //   - connection.onAnswer() → invokes onAnswered callback (wired
        //     by CallPlugin.load) or queues pendingAnswerCallId for JS
        //     to pick up later via getPendingAnswer.
        //   - CallConnection.onAnswered direct invoke as fallback when
        //     we bypassed Telecom.
        val connection = CallConnectionService.currentConnection
        if (connection != null) {
            connection.onAnswer()
        } else {
            Log.w(TAG, "No ConnectionService connection, notifying JS directly")
            CallConnection.onAnswered?.invoke(callId)
        }

        // Belt-and-braces: ensure the pending-answer markers are set on
        // CallConnection even when Telecom integration failed (e.g. a
        // region that rate-limits addNewIncomingCall and never calls
        // onCreateIncomingConnection — we'd have no roomId stashed).
        // JS-side consumePendingAnswerCallId correlates by roomId when
        // the push-side call_id doesn't match the Matrix call.callId,
        // so the roomId in particular must be present.
        val roomIdForPending = intent.getStringExtra("roomId")
        if (CallConnection.pendingAnswerCallId.isNullOrEmpty()) {
            CallConnection.pendingAnswerCallId = callId
        }
        if (CallConnection.pendingAnswerRoomId.isNullOrEmpty()) {
            CallConnection.pendingAnswerRoomId = roomIdForPending
        }

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
        startActivity(appBootIntent)

        CallConnectionService.dismissIncomingCallNotification(this)
        finish()
    }

    private fun decline() {
        Log.d(TAG, "Decline pressed")
        cleanup()

        val callId = intent.getStringExtra("callId") ?: ""
        val roomIdForPending = intent.getStringExtra("roomId")

        // Try ConnectionService — populates CallConnection.pendingReject*
        CallConnectionService.currentConnection?.onReject()

        // Defence-in-depth: clear accept markers (we're declining, not
        // accepting) and set reject markers if Telecom path was bypassed.
        CallConnection.pendingAnswerCallId = null
        CallConnection.pendingAnswerRoomId = null
        if (CallConnection.pendingRejectCallId.isNullOrEmpty()) {
            CallConnection.pendingRejectCallId = callId
        }
        if (CallConnection.pendingRejectRoomId.isNullOrEmpty()) {
            CallConnection.pendingRejectRoomId = roomIdForPending
        }

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
        finish()
    }

    /** Called when remote party cancels/hangs up */
    private fun dismissByRemote() {
        Log.d(TAG, "Remote hangup — dismissing")
        cleanup()
        // Clear accept markers so a stale invite can't re-trigger
        // the JS fast-path after the caller has cancelled.
        CallConnection.pendingAnswerCallId = null
        CallConnection.pendingAnswerRoomId = null
        CallConnectionService.dismissIncomingCallNotification(this)
        finish()
    }

    private fun cleanup() {
        stopRingtone()
        stopVibration()
        handler.removeCallbacks(autoRejectRunnable)
        handler.removeCallbacks(countdownRunnable)
    }

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

    private fun startRingtone() {
        try {
            val ringtoneUri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE)
            ringtone = RingtoneManager.getRingtone(applicationContext, ringtoneUri)
            ringtone?.audioAttributes = AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build()
            ringtone?.isLooping = true
            ringtone?.play()
        } catch (e: Exception) { /* ignore */ }
    }

    private fun startVibration() {
        try {
            vibrator = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                val vm = getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as VibratorManager
                vm.defaultVibrator
            } else {
                @Suppress("DEPRECATION")
                getSystemService(Context.VIBRATOR_SERVICE) as Vibrator
            }
            val pattern = longArrayOf(0, 1000, 1000)
            vibrator?.vibrate(VibrationEffect.createWaveform(pattern, 0))
        } catch (e: Exception) { /* ignore */ }
    }

    private fun stopRingtone() {
        ringtone?.stop()
        ringtone = null
    }

    private fun stopVibration() {
        vibrator?.cancel()
        vibrator = null
    }

    override fun onDestroy() {
        cleanup()
        pulseAnimator?.cancel()
        currentInstance = null
        super.onDestroy()
    }
}
