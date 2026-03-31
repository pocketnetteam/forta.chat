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
import com.forta.chat.utils.WindowInsetsHelper

class IncomingCallActivity : Activity() {

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
            if (hasVideo) "Входящий видеозвонок" else "Входящий аудиозвонок"
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

        // Try ConnectionService first; if unavailable, notify JS directly
        val connection = CallConnectionService.currentConnection
        if (connection != null) {
            connection.onAnswer()
        } else {
            Log.w(TAG, "No ConnectionService connection, notifying JS directly")
            CallConnection.onAnswered?.invoke(callId)
        }

        // Open app — JS handles the actual WebRTC answer via Matrix SDK
        val mainIntent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
            putExtra("push_call_accept", true)
            putExtra("callId", callId)
            putExtra("roomId", intent.getStringExtra("roomId"))
        }
        startActivity(mainIntent)
        CallConnectionService.dismissIncomingCallNotification(this)
        finish()
    }

    private fun decline() {
        Log.d(TAG, "Decline pressed")
        cleanup()

        // Try ConnectionService if available
        CallConnectionService.currentConnection?.onReject()

        // Just close — caller will see "no answer" / timeout
        CallConnectionService.dismissIncomingCallNotification(this)
        finish()
    }

    /** Called when remote party cancels/hangs up */
    private fun dismissByRemote() {
        Log.d(TAG, "Remote hangup — dismissing")
        cleanup()
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
