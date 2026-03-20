package com.forta.chat.plugins.calls

import android.app.Activity
import android.app.KeyguardManager
import android.content.Context
import android.media.AudioAttributes
import android.media.AudioManager
import android.media.RingtoneManager
import android.os.Build
import android.os.Bundle
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.view.Gravity
import android.view.WindowManager
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView

class IncomingCallActivity : Activity() {

    private var ringtone: android.media.Ringtone? = null
    private var vibrator: Vibrator? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

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

        // Keep screen on during incoming call
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        val callerName = intent.getStringExtra("callerName") ?: "Unknown"
        val callId = intent.getStringExtra("callId") ?: ""
        val hasVideo = intent.getBooleanExtra("hasVideo", false)

        // Start ringtone
        startRingtone()
        // Start vibration
        startVibration()

        // Build UI
        val layout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setPadding(64, 200, 64, 200)
            setBackgroundColor(0xFF1a1a2e.toInt())
        }

        val callTypeText = TextView(this).apply {
            text = if (hasVideo) "Video Call" else "Voice Call"
            textSize = 16f
            gravity = Gravity.CENTER
            setTextColor(0xFFaaaaaa.toInt())
        }

        val nameText = TextView(this).apply {
            text = callerName
            textSize = 32f
            gravity = Gravity.CENTER
            setTextColor(0xFFffffff.toInt())
        }

        val statusText = TextView(this).apply {
            text = "Incoming call..."
            textSize = 18f
            gravity = Gravity.CENTER
            setTextColor(0xFFcccccc.toInt())
        }

        val spacer = TextView(this).apply {
            text = ""
            textSize = 48f
        }

        val declineBtn = Button(this).apply {
            text = "Decline"
            textSize = 18f
            setBackgroundColor(0xFFe74c3c.toInt())
            setTextColor(0xFFffffff.toInt())
            setPadding(48, 24, 48, 24)
            setOnClickListener {
                stopRingtone()
                stopVibration()
                CallConnectionService.currentConnection?.onReject()
                finish()
            }
        }

        val acceptBtn = Button(this).apply {
            text = "Accept"
            textSize = 18f
            setBackgroundColor(0xFF2ecc71.toInt())
            setTextColor(0xFFffffff.toInt())
            setPadding(48, 24, 48, 24)
            setOnClickListener {
                stopRingtone()
                stopVibration()
                CallConnectionService.currentConnection?.onAnswer()
                finish()
            }
        }

        val buttonRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER
            val params = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f).apply {
                marginStart = 16
                marginEnd = 16
            }
            addView(declineBtn, params)
            addView(acceptBtn, params)
        }

        layout.addView(callTypeText)
        layout.addView(nameText)
        layout.addView(statusText)
        layout.addView(spacer)
        layout.addView(buttonRow)
        setContentView(layout)
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
        } catch (e: Exception) {
            // Ignore ringtone errors
        }
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
            val pattern = longArrayOf(0, 1000, 1000) // vibrate 1s, pause 1s
            vibrator?.vibrate(VibrationEffect.createWaveform(pattern, 0))
        } catch (e: Exception) {
            // Ignore vibration errors
        }
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
        stopRingtone()
        stopVibration()
        super.onDestroy()
    }
}
