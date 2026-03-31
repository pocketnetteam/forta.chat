package com.forta.chat.plugins.calls

import android.animation.Animator
import android.animation.AnimatorListenerAdapter
import android.animation.AnimatorSet
import android.animation.ObjectAnimator
import android.app.Activity
import android.app.PictureInPictureParams
import android.content.Context
import android.content.Intent
import android.content.res.Configuration
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
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
import android.view.animation.AccelerateDecelerateInterpolator
import android.widget.FrameLayout
import android.widget.ImageButton
import android.widget.LinearLayout
import android.widget.TextView
import com.forta.chat.R
import com.forta.chat.plugins.locale.LocaleHelper
import com.forta.chat.utils.WindowInsetsHelper
import com.forta.chat.plugins.webrtc.NativeWebRTCManager
import com.forta.chat.plugins.webrtc.WebRTCPlugin
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

    override fun attachBaseContext(newBase: Context) {
        super.attachBaseContext(LocaleHelper.wrapContext(newBase))
    }

    companion object {
        private const val TAG = "CallActivity"
        private const val CONTROLS_HIDE_DELAY_MS = 5000L
        private const val REQUEST_CAMERA_PERMISSION = 1002

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

        // Static callback for remote video received
        var onRemoteVideo: (() -> Unit)? = null

        // Static callback for native video toggle (needs JS renegotiation)
        var onNativeVideoToggle: ((Boolean) -> Unit)? = null

        // Static callback for remote video mute state changes
        var onRemoteVideoMuted: ((Boolean) -> Unit)? = null

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
    private lateinit var btnAudioRoute: ImageButton
    private lateinit var btnHangup: ImageButton

    // Voice mode views
    private var voiceBg: View? = null
    private var voiceCenter: View? = null
    private var avatarText: TextView? = null
    private var flipContainer: View? = null
    private var pulseAnimator: AnimatorSet? = null
    private var remoteNoVideo: View? = null
    private var remoteAvatarText: TextView? = null

    // State
    private var isMuted = false
    private var isVideoEnabled = true
    private var callType = "video"
    private var callerName = "Unknown"
    private var callDurationSeconds = 0
    private var isConnected = false

    // Audio routing
    private lateinit var audioRouter: AudioRouter

    // Sensors & Power
    private var sensorManager: SensorManager? = null
    private var proximitySensor: Sensor? = null
    private var proximityWakeLock: PowerManager.WakeLock? = null

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

        // Translucent window allows SurfaceView surfaces to be visible behind the window
        window.setFormat(android.graphics.PixelFormat.TRANSLUCENT)

        setContentView(R.layout.activity_call)
        bindViews()
        setupListeners()

        // Apply real system bar insets instead of hardcoded 48dp
        WindowInsetsHelper.setupEdgeToEdge(
            activity = this,
            topView = topBar,
            bottomView = controlsBar,
            onInsets = { top, _, _, _ ->
                val lp = localVideoView.layoutParams as FrameLayout.LayoutParams
                lp.topMargin = top + (16 * resources.displayMetrics.density).toInt()
                localVideoView.layoutParams = lp
            }
        )

        // Read extras
        callerName = intent.getStringExtra(EXTRA_CALLER_NAME) ?: "Unknown"
        callType = intent.getStringExtra(EXTRA_CALL_TYPE) ?: "video"
        isVideoEnabled = callType == "video"

        callerNameText.text = callerName
        callStatusText.text = getString(R.string.call_connecting)

        // Mode setup
        if (callType == "voice") {
            voiceBg?.visibility = View.VISIBLE
            voiceCenter?.visibility = View.VISIBLE
            remoteVideoView.visibility = View.GONE
            localVideoView.visibility = View.GONE
            flipContainer?.visibility = View.GONE
            avatarText?.text = callerName.take(2).uppercase()
            startPulseAnimation()
        } else {
            // Video call: show voice mode UI until remote video arrives
            voiceBg?.visibility = View.VISIBLE
            voiceCenter?.visibility = View.VISIBLE
            avatarText?.text = callerName.take(2).uppercase()
            remoteVideoView.visibility = View.GONE
            startPulseAnimation()
        }

        // Audio routing
        audioRouter = AudioRouter(this)
        audioRouter.setListener(object : AudioRouter.Listener {
            override fun onAudioDeviceChanged(state: AudioRouter.AudioDeviceState) {
                runOnUiThread { updateAudioRouteUI(state) }
            }
        })
        audioRouter.start(callType)

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

        // Always init renderers (remote video needed for all call types)
        initVideoRenderers()

        // Request camera permission if needed for video calls
        if (isVideoEnabled && checkSelfPermission(android.Manifest.permission.CAMERA)
            != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(android.Manifest.permission.CAMERA), REQUEST_CAMERA_PERMISSION)
        }
        updateButtonStates()

        // Register for call end
        onCallEnded = { runOnUiThread { finish() } }
        // Register for remote video
        onRemoteVideo = { runOnUiThread { onRemoteVideoReceived() } }
        // Register for remote video mute state
        onRemoteVideoMuted = { muted -> runOnUiThread { onRemoteVideoMuteChanged(muted) } }
        // Register for call connected
        onCallConnected = { runOnUiThread { handleCallConnected() } }

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

    override fun onRequestPermissionsResult(
        requestCode: Int, permissions: Array<out String>, grantResults: IntArray
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == REQUEST_CAMERA_PERMISSION &&
            grantResults.isNotEmpty() &&
            grantResults[0] == android.content.pm.PackageManager.PERMISSION_GRANTED) {
            // Camera permission granted — start local video
            val mgr = WebRTCPlugin.manager ?: return
            mgr.startLocalVideo("", localVideoView)
            localVideoView.visibility = View.VISIBLE
            setupLocalVideoDrag()
        }
    }

    override fun onDestroy() {
        handler.removeCallbacks(timerRunnable)
        handler.removeCallbacks(hideControlsRunnable)
        pulseAnimator?.cancel()
        onCallEnded = null
        onCallConnected = null
        onRemoteVideo = null
        onRemoteVideoMuted = null
        // Note: onNativeHangup is wired by WebRTCPlugin.load() and stays alive

        try {
            localVideoView.release()
            remoteVideoView.release()
        } catch (e: Exception) {
            Log.e(TAG, "Error releasing renderers", e)
        }

        audioRouter.stop()

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
        btnAudioRoute = findViewById(R.id.btn_audio_route)
        btnHangup = findViewById(R.id.btn_hangup)
        voiceBg = findViewById(R.id.voice_bg)
        voiceCenter = findViewById(R.id.voice_center)
        avatarText = findViewById(R.id.avatar_text)
        flipContainer = findViewById(R.id.flip_container)
        remoteNoVideo = findViewById(R.id.remote_no_video)
        remoteAvatarText = findViewById(R.id.remote_avatar_text)
    }

    private fun setupListeners() {
        btnMute.setOnClickListener { toggleMute() }
        btnVideo.setOnClickListener { toggleVideo() }
        btnFlip.setOnClickListener { flipCamera() }
        btnAudioRoute.setOnClickListener { showAudioRouteSheet() }
        btnHangup.setOnClickListener { hangup() }

        // Tap anywhere to toggle controls visibility
        remoteVideoView.setOnClickListener { toggleControlsVisibility() }
    }

    private var renderersInitialized = false

    private fun initVideoRenderers() {
        val mgr = WebRTCPlugin.manager ?: run {
            Log.w(TAG, "initVideoRenderers: manager is null!")
            return
        }
        val eglBase = mgr.getEglBase() ?: run {
            Log.w(TAG, "initVideoRenderers: eglBase is null!")
            return
        }

        if (!renderersInitialized) {
            Log.d(TAG, "initVideoRenderers: initializing, remoteView visible=${remoteVideoView.visibility == View.VISIBLE}")

            remoteVideoView.init(eglBase.eglBaseContext, null)
            remoteVideoView.setScalingType(RendererCommon.ScalingType.SCALE_ASPECT_FIT)
            remoteVideoView.setEnableHardwareScaler(true)
            remoteVideoView.setMirror(false)

            localVideoView.init(eglBase.eglBaseContext, null)
            localVideoView.setScalingType(RendererCommon.ScalingType.SCALE_ASPECT_FIT)
            localVideoView.setEnableHardwareScaler(true)
            localVideoView.setMirror(true)
            localVideoView.setZOrderMediaOverlay(true)

            // Attach remote renderer (may already have tracks from WebRTC negotiation)
            mgr.attachRemoteRenderer(remoteVideoView)
            renderersInitialized = true

            // Check if remote video tracks already exist — hide placeholder if so
            if (mgr.hasRemoteVideoTracks()) {
                remoteNoVideo?.visibility = View.GONE
                remoteVideoView.visibility = View.VISIBLE
            }
            Log.d(TAG, "initVideoRenderers: renderers initialized, remote renderer attached")
        }

        // Attach local video only for video calls with camera permission
        if (isVideoEnabled && checkSelfPermission(android.Manifest.permission.CAMERA)
            == android.content.pm.PackageManager.PERMISSION_GRANTED) {
            mgr.startLocalVideo("", localVideoView)
            setupLocalVideoDrag()
        } else if (!isVideoEnabled) {
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
            addListener(object : AnimatorListenerAdapter() {
                override fun onAnimationEnd(animation: Animator) {
                    if (!isFinishing) animation.start()
                }
            })
            start()
        }
    }

    // -----------------------------------------------------------------------
    // Call state updates (called from WebRTCPlugin / bridge)
    // -----------------------------------------------------------------------

    fun handleCallConnected() {
        runOnUiThread {
            isConnected = true
            callStatusText.text = "00:00"
            handler.post(timerRunnable)
            scheduleHideControls()
        }
    }

    fun onRemoteVideoReceived() {
        runOnUiThread {
            remoteNoVideo?.visibility = View.GONE
            remoteVideoView.visibility = View.VISIBLE
            // Hide voice mode UI when remote video arrives
            voiceBg?.visibility = View.GONE
            voiceCenter?.visibility = View.GONE
            pulseAnimator?.cancel()
        }
    }

    private fun onRemoteVideoMuteChanged(muted: Boolean) {
        if (muted) {
            // Show voice mode UI (same as voice call)
            remoteNoVideo?.visibility = View.GONE
            remoteVideoView.visibility = View.GONE
            voiceBg?.visibility = View.VISIBLE
            voiceCenter?.visibility = View.VISIBLE
            avatarText?.text = callerName.take(2).uppercase()
            startPulseAnimation()
        } else {
            // Show remote video
            remoteNoVideo?.visibility = View.GONE
            remoteVideoView.visibility = View.VISIBLE
            voiceBg?.visibility = View.GONE
            voiceCenter?.visibility = View.GONE
            pulseAnimator?.cancel()
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
        if (!isVideoEnabled && checkSelfPermission(android.Manifest.permission.CAMERA)
            != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(android.Manifest.permission.CAMERA), REQUEST_CAMERA_PERMISSION)
            return
        }
        isVideoEnabled = !isVideoEnabled
        val mgr = WebRTCPlugin.manager
        mgr?.setVideoEnabled(isVideoEnabled)
        if (isVideoEnabled) {
            // Switch from voice to video mode
            voiceBg?.visibility = View.GONE
            voiceCenter?.visibility = View.GONE
            pulseAnimator?.cancel()
            remoteVideoView.visibility = View.VISIBLE
            localVideoView.visibility = View.VISIBLE
            flipContainer?.visibility = View.VISIBLE

            // Ensure renderers are initialized
            initVideoRenderers()
            mgr?.startLocalVideo("", localVideoView)
            setupLocalVideoDrag()
        } else {
            // Switch from video to voice mode
            localVideoView.visibility = View.GONE
            flipContainer?.visibility = View.GONE
        }
        updateButtonStates()

        // Notify JS for SDP renegotiation (mid-call video toggle)
        onNativeVideoToggle?.invoke(isVideoEnabled)
    }

    private fun flipCamera() {
        WebRTCPlugin.manager?.switchCamera()
    }

    private fun showAudioRouteSheet() {
        val state = audioRouter.getState()
        val sheetView = layoutInflater.inflate(R.layout.bottom_sheet_audio_route, null)
        val container = sheetView.findViewById<LinearLayout>(R.id.audio_devices_container)

        val popup = android.widget.PopupWindow(
            sheetView,
            android.view.ViewGroup.LayoutParams.MATCH_PARENT,
            android.view.ViewGroup.LayoutParams.WRAP_CONTENT,
            true
        ).apply {
            animationStyle = android.R.style.Animation_InputMethod
            setBackgroundDrawable(android.graphics.drawable.ColorDrawable(android.graphics.Color.TRANSPARENT))
            elevation = 16f
        }

        for (device in state.available) {
            val row = layoutInflater.inflate(R.layout.item_audio_device, container, false)
            val icon = row.findViewById<android.widget.ImageView>(R.id.device_icon)
            val name = row.findViewById<TextView>(R.id.device_name)
            val check = row.findViewById<android.widget.ImageView>(R.id.device_check)

            icon.setImageResource(when (device) {
                AudioRouter.Device.EARPIECE -> R.drawable.ic_hearing
                AudioRouter.Device.SPEAKER -> R.drawable.ic_volume_up
                AudioRouter.Device.BLUETOOTH -> R.drawable.ic_bluetooth
                AudioRouter.Device.WIRED_HEADSET -> R.drawable.ic_hearing
            })
            name.text = when (device) {
                AudioRouter.Device.BLUETOOTH -> audioRouter.getBluetoothDeviceName() ?: getString(R.string.call_bluetooth)
                AudioRouter.Device.EARPIECE -> getString(R.string.call_earpiece)
                AudioRouter.Device.SPEAKER -> getString(R.string.call_speaker)
                AudioRouter.Device.WIRED_HEADSET -> getString(R.string.call_wired_headset)
            }
            check.visibility = if (device == state.active) View.VISIBLE else View.GONE

            row.setOnClickListener {
                audioRouter.setDevice(device)
                popup.dismiss()
            }
            container.addView(row)
        }

        popup.showAtLocation(controlsBar, android.view.Gravity.BOTTOM, 0, 0)
    }

    private fun updateAudioRouteUI(state: AudioRouter.AudioDeviceState) {
        val iconRes = when (state.active) {
            AudioRouter.Device.EARPIECE -> R.drawable.ic_hearing
            AudioRouter.Device.SPEAKER -> R.drawable.ic_volume_up
            AudioRouter.Device.BLUETOOTH -> R.drawable.ic_bluetooth
            AudioRouter.Device.WIRED_HEADSET -> R.drawable.ic_hearing
        }
        btnAudioRoute.setImageResource(iconRes)

        val isNonDefault = state.active != AudioRouter.Device.EARPIECE
        btnAudioRoute.setBackgroundResource(
            if (isNonDefault) R.drawable.btn_call_control_active else R.drawable.btn_call_control
        )
        val tint = if (isNonDefault) android.graphics.Color.parseColor("#1A1A2E") else android.graphics.Color.WHITE
        btnAudioRoute.setColorFilter(tint)

        val label = when (state.active) {
            AudioRouter.Device.BLUETOOTH -> audioRouter.getBluetoothDeviceName() ?: getString(R.string.call_bluetooth_short)
            AudioRouter.Device.EARPIECE -> getString(R.string.call_earpiece)
            AudioRouter.Device.SPEAKER -> getString(R.string.call_speaker)
            AudioRouter.Device.WIRED_HEADSET -> getString(R.string.call_wired_headset)
        }
        findViewById<TextView>(R.id.label_audio_route)?.text = label
    }

    private fun hangup() {
        // Signal JS side to hang up the call properly (sends m.call.hangup)
        onNativeHangup?.invoke()
        finish()
    }

    private fun updateButtonStates() {
        btnMute.setImageResource(if (isMuted) R.drawable.ic_mic_off else R.drawable.ic_mic)
        btnMute.setBackgroundResource(if (isMuted) R.drawable.btn_call_control_active else R.drawable.btn_call_control)
        val muteTint = if (isMuted) android.graphics.Color.parseColor("#1A1A2E") else android.graphics.Color.WHITE
        btnMute.setColorFilter(muteTint)
        findViewById<TextView>(R.id.label_mute)?.text = if (isMuted) getString(R.string.call_unmute) else getString(R.string.call_mute)

        btnVideo.setImageResource(if (isVideoEnabled) R.drawable.ic_videocam else R.drawable.ic_videocam_off)
        btnVideo.setBackgroundResource(if (!isVideoEnabled) R.drawable.btn_call_control_active else R.drawable.btn_call_control)
        val videoTint = if (!isVideoEnabled) android.graphics.Color.parseColor("#1A1A2E") else android.graphics.Color.WHITE
        btnVideo.setColorFilter(videoTint)
        findViewById<TextView>(R.id.label_video)?.text = if (isVideoEnabled) getString(R.string.call_video_off) else getString(R.string.call_video_on)
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
