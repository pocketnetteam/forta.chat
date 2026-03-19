package com.bastyon.chat.plugins.calls

import android.app.Activity
import android.app.PictureInPictureParams
import android.content.Context
import android.content.Intent
import android.content.res.Configuration
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.media.AudioManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.util.Log
import android.util.Rational
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.widget.ImageButton
import android.widget.TextView
import com.bastyon.chat.R
import com.bastyon.chat.plugins.webrtc.NativeWebRTCManager
import com.bastyon.chat.plugins.webrtc.WebRTCPlugin
import org.webrtc.RendererCommon
import org.webrtc.SurfaceViewRenderer
import org.webrtc.VideoTrack

/**
 * Full-screen native call Activity with WebRTC video rendering.
 *
 * Features:
 * - SurfaceViewRenderer for remote + local video
 * - Call controls: mute, video toggle, camera flip, speaker, hangup
 * - Proximity sensor for voice calls (screen off when near ear)
 * - Picture-in-Picture support
 * - Auto-hiding controls (show on tap, hide after 5s)
 */
class CallActivity : Activity(), SensorEventListener {

    companion object {
        private const val TAG = "CallActivity"
        private const val CONTROLS_HIDE_DELAY_MS = 5000L

        const val EXTRA_CALLER_NAME = "callerName"
        const val EXTRA_CALL_TYPE = "callType"
        const val EXTRA_CALL_ID = "callId"
        const val EXTRA_DIRECTION = "direction"

        // Static callback for hangup from JS side
        var onCallEnded: (() -> Unit)? = null

        // Static callback for ICE connected state
        var onCallConnected: (() -> Unit)? = null

        // Static callback for native hangup button
        var onNativeHangup: (() -> Unit)? = null

        fun launch(context: Context, callerName: String, callType: String, callId: String, direction: String) {
            val intent = Intent(context, CallActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
                putExtra(EXTRA_CALLER_NAME, callerName)
                putExtra(EXTRA_CALL_TYPE, callType)
                putExtra(EXTRA_CALL_ID, callId)
                putExtra(EXTRA_DIRECTION, direction)
            }
            context.startActivity(intent)
        }
    }

    // UI
    private lateinit var remoteVideoView: SurfaceViewRenderer
    private lateinit var localVideoView: SurfaceViewRenderer
    private lateinit var callerNameText: TextView
    private lateinit var callStatusText: TextView
    private lateinit var topBar: View
    private lateinit var controlsBar: View

    // Buttons
    private lateinit var btnMute: ImageButton
    private lateinit var btnVideo: ImageButton
    private lateinit var btnFlip: ImageButton
    private lateinit var btnSpeaker: ImageButton
    private lateinit var btnHangup: ImageButton

    // State
    private var isMuted = false
    private var isVideoEnabled = true
    private var isSpeakerOn = false
    private var callType = "video"
    private var callDurationSeconds = 0
    private var isConnected = false

    // Sensors & Power
    private var sensorManager: SensorManager? = null
    private var proximitySensor: Sensor? = null
    private var proximityWakeLock: PowerManager.WakeLock? = null
    private var audioManager: AudioManager? = null

    // Timer
    private val handler = Handler(Looper.getMainLooper())
    private val timerRunnable = object : Runnable {
        override fun run() {
            callDurationSeconds++
            updateTimerDisplay()
            handler.postDelayed(this, 1000)
        }
    }

    // Auto-hide controls
    private val hideControlsRunnable = Runnable {
        if (isConnected && callType == "video") {
            topBar.animate().alpha(0f).setDuration(300).start()
            controlsBar.animate().alpha(0f).setDuration(300).start()
        }
    }

    // -----------------------------------------------------------------------
    // Lifecycle
    // -----------------------------------------------------------------------

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Keep screen on, show over lock screen
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true)
            setTurnScreenOn(true)
        } else {
            @Suppress("DEPRECATION")
            window.addFlags(
                WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or
                WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON
            )
        }

        setContentView(R.layout.activity_call)
        bindViews()
        setupListeners()

        // Read extras
        val callerName = intent.getStringExtra(EXTRA_CALLER_NAME) ?: "Unknown"
        callType = intent.getStringExtra(EXTRA_CALL_TYPE) ?: "video"
        isVideoEnabled = callType == "video"

        callerNameText.text = callerName
        callStatusText.text = "Connecting..."

        // Audio
        audioManager = getSystemService(Context.AUDIO_SERVICE) as AudioManager
        audioManager?.mode = AudioManager.MODE_IN_COMMUNICATION
        if (callType == "video") {
            audioManager?.isSpeakerphoneOn = true
            isSpeakerOn = true
        }

        // Proximity sensor (for voice calls)
        sensorManager = getSystemService(Context.SENSOR_SERVICE) as SensorManager
        proximitySensor = sensorManager?.getDefaultSensor(Sensor.TYPE_PROXIMITY)

        // Proximity wake lock
        val powerManager = getSystemService(Context.POWER_SERVICE) as PowerManager
        if (powerManager.isWakeLockLevelSupported(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK)) {
            proximityWakeLock = powerManager.newWakeLock(
                PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK,
                "bastyon:call_proximity"
            )
        }

        initVideoRenderers()
        updateButtonStates()

        // Register for call end
        onCallEnded = { runOnUiThread { finish() } }
        // Register for call connected
        onCallConnected = { runOnUiThread { onCallConnected() } }

        Log.d(TAG, "CallActivity created: $callerName, type=$callType")
    }

    override fun onResume() {
        super.onResume()
        if (callType == "voice") {
            proximitySensor?.let {
                sensorManager?.registerListener(this, it, SensorManager.SENSOR_DELAY_NORMAL)
            }
            proximityWakeLock?.let {
                if (!it.isHeld) it.acquire()
            }
        }
    }

    override fun onPause() {
        sensorManager?.unregisterListener(this)
        proximityWakeLock?.let {
            if (it.isHeld) it.release()
        }
        super.onPause()
    }

    override fun onDestroy() {
        handler.removeCallbacks(timerRunnable)
        handler.removeCallbacks(hideControlsRunnable)
        onCallEnded = null
        onCallConnected = null
        // Note: onNativeHangup is wired by WebRTCPlugin.load() and stays alive

        try {
            localVideoView.release()
            remoteVideoView.release()
        } catch (e: Exception) {
            Log.e(TAG, "Error releasing renderers", e)
        }

        audioManager?.mode = AudioManager.MODE_NORMAL
        audioManager?.isSpeakerphoneOn = false

        super.onDestroy()
    }

    // -----------------------------------------------------------------------
    // View setup
    // -----------------------------------------------------------------------

    private fun bindViews() {
        remoteVideoView = findViewById(R.id.remote_video)
        localVideoView = findViewById(R.id.local_video)
        callerNameText = findViewById(R.id.caller_name)
        callStatusText = findViewById(R.id.call_status)
        topBar = findViewById(R.id.top_bar)
        controlsBar = findViewById(R.id.controls_bar)
        btnMute = findViewById(R.id.btn_mute)
        btnVideo = findViewById(R.id.btn_video)
        btnFlip = findViewById(R.id.btn_flip)
        btnSpeaker = findViewById(R.id.btn_speaker)
        btnHangup = findViewById(R.id.btn_hangup)
    }

    private fun setupListeners() {
        btnMute.setOnClickListener { toggleMute() }
        btnVideo.setOnClickListener { toggleVideo() }
        btnFlip.setOnClickListener { flipCamera() }
        btnSpeaker.setOnClickListener { toggleSpeaker() }
        btnHangup.setOnClickListener { hangup() }

        // Tap anywhere to toggle controls visibility
        remoteVideoView.setOnClickListener { toggleControlsVisibility() }
    }

    private fun initVideoRenderers() {
        val mgr = WebRTCPlugin.manager ?: return
        val eglBase = mgr.getEglBase() ?: return

        remoteVideoView.init(eglBase.eglBaseContext, null)
        remoteVideoView.setScalingType(RendererCommon.ScalingType.SCALE_ASPECT_FIT)
        remoteVideoView.setEnableHardwareScaler(true)
        remoteVideoView.setMirror(false)

        localVideoView.init(eglBase.eglBaseContext, null)
        localVideoView.setScalingType(RendererCommon.ScalingType.SCALE_ASPECT_FIT)
        localVideoView.setEnableHardwareScaler(true)
        localVideoView.setMirror(true)
        localVideoView.setZOrderMediaOverlay(true)

        // Attach local video only for video calls
        if (isVideoEnabled) {
            mgr.startLocalVideo("", localVideoView)
            setupLocalVideoDrag()
        } else {
            localVideoView.visibility = View.GONE
        }
    }

    private fun setupLocalVideoDrag() {
        var dX = 0f
        var dY = 0f
        localVideoView.setOnTouchListener { view, event ->
            when (event.action) {
                MotionEvent.ACTION_DOWN -> {
                    dX = view.x - event.rawX
                    dY = view.y - event.rawY
                    true
                }
                MotionEvent.ACTION_MOVE -> {
                    view.x = event.rawX + dX
                    view.y = event.rawY + dY
                    true
                }
                else -> false
            }
        }
    }

    // -----------------------------------------------------------------------
    // Call state updates (called from WebRTCPlugin / bridge)
    // -----------------------------------------------------------------------

    fun onCallConnected() {
        runOnUiThread {
            isConnected = true
            callStatusText.text = "00:00"
            handler.post(timerRunnable)
            scheduleHideControls()
        }
    }

    fun attachRemoteVideoTrack(track: VideoTrack) {
        runOnUiThread {
            track.addSink(remoteVideoView)
        }
    }

    // -----------------------------------------------------------------------
    // Controls
    // -----------------------------------------------------------------------

    private fun toggleMute() {
        isMuted = !isMuted
        WebRTCPlugin.manager?.setAudioEnabled(!isMuted)
        updateButtonStates()
    }

    private fun toggleVideo() {
        isVideoEnabled = !isVideoEnabled
        WebRTCPlugin.manager?.setVideoEnabled(isVideoEnabled)
        localVideoView.visibility = if (isVideoEnabled) View.VISIBLE else View.GONE
        updateButtonStates()
    }

    private fun flipCamera() {
        WebRTCPlugin.manager?.switchCamera()
    }

    private fun toggleSpeaker() {
        isSpeakerOn = !isSpeakerOn
        audioManager?.isSpeakerphoneOn = isSpeakerOn
        updateButtonStates()
    }

    private fun hangup() {
        // Signal JS side to hang up the call properly (sends m.call.hangup)
        onNativeHangup?.invoke()
        finish()
    }

    private fun updateButtonStates() {
        // Use alpha to indicate toggle state (1.0 = active, 0.4 = inactive)
        btnMute.alpha = if (isMuted) 1.0f else 0.5f
        btnVideo.alpha = if (isVideoEnabled) 1.0f else 0.5f
        btnSpeaker.alpha = if (isSpeakerOn) 1.0f else 0.5f

        // Update labels
        findViewById<TextView>(R.id.label_mute)?.text = if (isMuted) "Unmute" else "Mute"
        findViewById<TextView>(R.id.label_video)?.text = if (isVideoEnabled) "Video Off" else "Video On"
        findViewById<TextView>(R.id.label_speaker)?.text = if (isSpeakerOn) "Earpiece" else "Speaker"
    }

    // -----------------------------------------------------------------------
    // Controls visibility
    // -----------------------------------------------------------------------

    private fun toggleControlsVisibility() {
        val isVisible = topBar.alpha > 0.5f
        if (isVisible) {
            topBar.animate().alpha(0f).setDuration(300).start()
            controlsBar.animate().alpha(0f).setDuration(300).start()
        } else {
            topBar.animate().alpha(1f).setDuration(300).start()
            controlsBar.animate().alpha(1f).setDuration(300).start()
            scheduleHideControls()
        }
    }

    private fun scheduleHideControls() {
        handler.removeCallbacks(hideControlsRunnable)
        handler.postDelayed(hideControlsRunnable, CONTROLS_HIDE_DELAY_MS)
    }

    // -----------------------------------------------------------------------
    // Timer
    // -----------------------------------------------------------------------

    private fun updateTimerDisplay() {
        val minutes = callDurationSeconds / 60
        val seconds = callDurationSeconds % 60
        callStatusText.text = String.format("%02d:%02d", minutes, seconds)
    }

    // -----------------------------------------------------------------------
    // Proximity sensor
    // -----------------------------------------------------------------------

    override fun onSensorChanged(event: SensorEvent) {
        if (event.sensor.type != Sensor.TYPE_PROXIMITY) return
        val near = event.values[0] < (proximitySensor?.maximumRange ?: 5f)
        if (near) {
            if (proximityWakeLock?.isHeld == false) {
                proximityWakeLock?.acquire()
            }
        } else {
            if (proximityWakeLock?.isHeld == true) {
                proximityWakeLock?.release()
            }
        }
    }

    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) {}

    // -----------------------------------------------------------------------
    // Picture-in-Picture
    // -----------------------------------------------------------------------

    override fun onUserLeaveHint() {
        if (isConnected && callType == "video" && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            enterPipMode()
        }
    }

    private fun enterPipMode() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val params = PictureInPictureParams.Builder()
                .setAspectRatio(Rational(9, 16))
                .build()
            enterPictureInPictureMode(params)
        }
    }

    override fun onPictureInPictureModeChanged(
        isInPictureInPictureMode: Boolean,
        newConfig: Configuration
    ) {
        if (isInPictureInPictureMode) {
            // Hide controls in PiP
            topBar.visibility = View.GONE
            controlsBar.visibility = View.GONE
            localVideoView.visibility = View.GONE
        } else {
            topBar.visibility = View.VISIBLE
            controlsBar.visibility = View.VISIBLE
            if (isVideoEnabled) {
                localVideoView.visibility = View.VISIBLE
            }
        }
    }
}
