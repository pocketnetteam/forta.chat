package com.forta.chat.plugins.webrtc

import android.content.Context
import android.content.Intent
import android.media.projection.MediaProjection
import android.util.Log
import org.webrtc.*
import org.webrtc.audio.JavaAudioDeviceModule

/**
 * Manages multiple native WebRTC peer connections with hardware-accelerated
 * video encoding/decoding via Google's libwebrtc.
 *
 * Each peer connection is identified by a peerId string from the JS side.
 * The SDK creates multiple PeerConnections during call setup (glare detection,
 * renegotiation), so we must support concurrent instances.
 */
class NativeWebRTCManager(private val context: Context) {

    companion object {
        private const val TAG = "NativeWebRTCManager"
        private const val VIDEO_WIDTH = 1280
        private const val VIDEO_HEIGHT = 720
        private const val VIDEO_FPS = 30
    }

    interface Listener {
        fun onIceCandidate(peerId: String, candidate: IceCandidate)
        fun onIceConnectionStateChange(peerId: String, state: PeerConnection.IceConnectionState)
        fun onAddTrack(peerId: String, receiver: RtpReceiver, streams: Array<out MediaStream>)
        fun onRemoveTrack(peerId: String, receiver: RtpReceiver)
        fun onRenegotiationNeeded(peerId: String)
    }

    private var factory: PeerConnectionFactory? = null
    private var eglBase: EglBase? = null

    // Multiple peer connections keyed by peerId
    private val peerConnections = mutableMapOf<String, PeerConnection>()

    // Local media (shared across PCs — one camera/mic for the device)
    private var localAudioTrack: AudioTrack? = null
    private var localVideoTrack: VideoTrack? = null
    private var videoCapturer: CameraVideoCapturer? = null
    private var surfaceTextureHelper: SurfaceTextureHelper? = null
    private var localAudioSource: AudioSource? = null
    private var localVideoSource: VideoSource? = null

    // Screen capture
    private var screenCapturer: ScreenCapturerAndroid? = null
    private var screenVideoSource: VideoSource? = null
    private var screenVideoTrack: VideoTrack? = null
    private var screenSurfaceHelper: SurfaceTextureHelper? = null
    private var isScreenSharing = false

    // Renderers
    private var localRenderer: SurfaceViewRenderer? = null
    private var remoteRenderer: SurfaceViewRenderer? = null

    private var listener: Listener? = null
    private var isInitialized = false

    // -----------------------------------------------------------------------
    // Initialization
    // -----------------------------------------------------------------------

    fun initialize() {
        if (isInitialized) return

        eglBase = EglBase.create()

        val initOptions = PeerConnectionFactory.InitializationOptions.builder(context)
            .setEnableInternalTracer(false)
            .createInitializationOptions()
        PeerConnectionFactory.initialize(initOptions)

        val encoderFactory = DefaultVideoEncoderFactory(
            eglBase!!.eglBaseContext,
            true,  // enableIntelVp8Encoder
            true   // enableH264HighProfile
        )
        val decoderFactory = DefaultVideoDecoderFactory(eglBase!!.eglBaseContext)

        val audioDeviceModule = JavaAudioDeviceModule.builder(context)
            .setUseHardwareAcousticEchoCanceler(true)
            .setUseHardwareNoiseSuppressor(true)
            .createAudioDeviceModule()

        factory = PeerConnectionFactory.builder()
            .setVideoEncoderFactory(encoderFactory)
            .setVideoDecoderFactory(decoderFactory)
            .setAudioDeviceModule(audioDeviceModule)
            .createPeerConnectionFactory()

        isInitialized = true
        Log.d(TAG, "Initialized with HW acceleration")
    }

    fun getEglBase(): EglBase? = eglBase

    // -----------------------------------------------------------------------
    // Peer Connection
    // -----------------------------------------------------------------------

    fun createPeerConnection(peerId: String, iceServers: List<PeerConnection.IceServer>, listener: Listener) {
        this.listener = listener

        // Close existing PC with same ID if any
        peerConnections[peerId]?.let {
            try { it.close() } catch (_: Exception) {}
            peerConnections.remove(peerId)
        }

        val rtcConfig = PeerConnection.RTCConfiguration(iceServers).apply {
            sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
            continualGatheringPolicy = PeerConnection.ContinualGatheringPolicy.GATHER_CONTINUALLY
            iceCandidatePoolSize = 10
        }

        val pc = factory?.createPeerConnection(rtcConfig, object : PeerConnection.Observer {
            override fun onIceCandidate(candidate: IceCandidate) {
                Log.d(TAG, "[$peerId] onIceCandidate: ${candidate.sdpMid}")
                listener.onIceCandidate(peerId, candidate)
            }

            override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>) {}

            override fun onIceConnectionChange(state: PeerConnection.IceConnectionState) {
                Log.d(TAG, "[$peerId] ICE connection state: $state")
                listener.onIceConnectionStateChange(peerId, state)
            }

            override fun onIceConnectionReceivingChange(receiving: Boolean) {}
            override fun onIceGatheringChange(state: PeerConnection.IceGatheringState) {}

            override fun onAddStream(stream: MediaStream) {}
            override fun onRemoveStream(stream: MediaStream) {}

            override fun onAddTrack(receiver: RtpReceiver, streams: Array<out MediaStream>) {
                Log.d(TAG, "[$peerId] onAddTrack: ${receiver.track()?.kind()}")
                listener.onAddTrack(peerId, receiver, streams)
            }

            override fun onTrack(transceiver: RtpTransceiver) {
                Log.d(TAG, "[$peerId] onTrack: ${transceiver.receiver.track()?.kind()}")
            }

            override fun onRemoveTrack(receiver: RtpReceiver) {
                listener.onRemoveTrack(peerId, receiver)
            }

            override fun onDataChannel(dc: DataChannel) {}
            override fun onSignalingChange(state: PeerConnection.SignalingState) {}
            override fun onConnectionChange(state: PeerConnection.PeerConnectionState) {
                Log.d(TAG, "[$peerId] Connection state: $state")
            }
            override fun onRenegotiationNeeded() {
                // Do NOT forward to JS — the proxy fires synthetic
                // negotiationneeded from addTrack when needed.  Native
                // renegotiation events caused by our own track management
                // (startLocalAudio/Video) would trigger premature offers.
                Log.d(TAG, "[$peerId] onRenegotiationNeeded (suppressed)")
            }
            override fun onSelectedCandidatePairChanged(event: CandidatePairChangeEvent?) {}
        })

        if (pc != null) {
            peerConnections[peerId] = pc

            // Auto-attach existing local tracks (getUserMedia runs before createPC)
            localAudioTrack?.let {
                pc.addTrack(it, listOf("stream0"))
                Log.d(TAG, "[$peerId] Auto-attached audio track")
            }
            localVideoTrack?.let {
                pc.addTrack(it, listOf("stream0"))
                Log.d(TAG, "[$peerId] Auto-attached video track")
            }

            Log.d(TAG, "[$peerId] PeerConnection created (total: ${peerConnections.size})")
        } else {
            Log.e(TAG, "[$peerId] Failed to create PeerConnection")
        }
    }

    // -----------------------------------------------------------------------
    // SDP
    // -----------------------------------------------------------------------

    fun createOffer(peerId: String, callback: (SessionDescription?) -> Unit) {
        val pc = peerConnections[peerId]
        if (pc == null) {
            Log.e(TAG, "[$peerId] createOffer: no PeerConnection")
            callback(null)
            return
        }
        // Let Unified Plan determine m-lines from attached tracks.
        // No OfferToReceiveVideo — avoids sending video m-line for voice calls.
        val constraints = MediaConstraints()
        pc.createOffer(object : SdpObserver {
            override fun onCreateSuccess(sdp: SessionDescription) {
                Log.d(TAG, "[$peerId] createOffer success")
                callback(sdp)
            }
            override fun onCreateFailure(error: String) {
                Log.e(TAG, "[$peerId] createOffer failed: $error")
                callback(null)
            }
            override fun onSetSuccess() {}
            override fun onSetFailure(error: String) {}
        }, constraints)
    }

    fun createAnswer(peerId: String, callback: (SessionDescription?) -> Unit) {
        val pc = peerConnections[peerId]
        if (pc == null) {
            Log.e(TAG, "[$peerId] createAnswer: no PeerConnection")
            callback(null)
            return
        }
        val constraints = MediaConstraints()
        pc.createAnswer(object : SdpObserver {
            override fun onCreateSuccess(sdp: SessionDescription) {
                Log.d(TAG, "[$peerId] createAnswer success")
                callback(sdp)
            }
            override fun onCreateFailure(error: String) {
                Log.e(TAG, "[$peerId] createAnswer failed: $error")
                callback(null)
            }
            override fun onSetSuccess() {}
            override fun onSetFailure(error: String) {}
        }, constraints)
    }

    fun setLocalDescription(peerId: String, sdp: SessionDescription, callback: (Boolean) -> Unit) {
        val pc = peerConnections[peerId]
        if (pc == null) {
            Log.e(TAG, "[$peerId] setLocalDescription: no PeerConnection")
            callback(false)
            return
        }
        pc.setLocalDescription(object : SdpObserver {
            override fun onSetSuccess() {
                Log.d(TAG, "[$peerId] setLocalDescription success")
                callback(true)
            }
            override fun onSetFailure(error: String) {
                Log.e(TAG, "[$peerId] setLocalDescription failed: $error")
                callback(false)
            }
            override fun onCreateSuccess(sdp: SessionDescription?) {}
            override fun onCreateFailure(error: String?) {}
        }, sdp)
    }

    fun setRemoteDescription(peerId: String, sdp: SessionDescription, callback: (Boolean) -> Unit) {
        val pc = peerConnections[peerId]
        if (pc == null) {
            Log.e(TAG, "[$peerId] setRemoteDescription: no PeerConnection")
            callback(false)
            return
        }
        pc.setRemoteDescription(object : SdpObserver {
            override fun onSetSuccess() {
                Log.d(TAG, "[$peerId] setRemoteDescription success")
                callback(true)
            }
            override fun onSetFailure(error: String) {
                Log.e(TAG, "[$peerId] setRemoteDescription failed: $error")
                callback(false)
            }
            override fun onCreateSuccess(sdp: SessionDescription?) {}
            override fun onCreateFailure(error: String?) {}
        }, sdp)
    }

    fun addIceCandidate(peerId: String, candidate: IceCandidate): Boolean {
        val pc = peerConnections[peerId]
        if (pc == null) {
            Log.e(TAG, "[$peerId] addIceCandidate: no PeerConnection")
            return false
        }
        return pc.addIceCandidate(candidate)
    }

    // -----------------------------------------------------------------------
    // Local Media
    // -----------------------------------------------------------------------

    fun startLocalAudio(peerId: String) {
        if (localAudioTrack != null) {
            // Already started — add to specific PC if provided
            if (peerId.isNotEmpty()) {
                peerConnections[peerId]?.addTrack(localAudioTrack, listOf("stream0"))
            }
            return
        }

        val audioConstraints = MediaConstraints().apply {
            mandatory.add(MediaConstraints.KeyValuePair("googEchoCancellation", "true"))
            mandatory.add(MediaConstraints.KeyValuePair("googNoiseSuppression", "true"))
            mandatory.add(MediaConstraints.KeyValuePair("googAutoGainControl", "true"))
        }

        localAudioSource = factory?.createAudioSource(audioConstraints)
        localAudioTrack = factory?.createAudioTrack("audio0", localAudioSource)
        localAudioTrack?.setEnabled(true)

        // Add to specific PC or all active PCs
        if (peerId.isNotEmpty()) {
            peerConnections[peerId]?.addTrack(localAudioTrack, listOf("stream0"))
        } else {
            for ((_, pc) in peerConnections) {
                pc.addTrack(localAudioTrack, listOf("stream0"))
            }
        }
        Log.d(TAG, "Local audio started (peerId=$peerId, pcs=${peerConnections.size})")
    }

    fun startLocalVideo(peerId: String, renderer: SurfaceViewRenderer? = null) {
        if (localVideoTrack != null) {
            // Already started — add to specific PC if provided
            if (peerId.isNotEmpty()) {
                peerConnections[peerId]?.addTrack(localVideoTrack, listOf("stream0"))
            }
            return
        }

        val enumerator = Camera2Enumerator(context)
        val cameraName = enumerator.deviceNames.firstOrNull { enumerator.isFrontFacing(it) }
            ?: enumerator.deviceNames.firstOrNull()
            ?: run {
                Log.e(TAG, "No camera found")
                return
            }

        videoCapturer = enumerator.createCapturer(cameraName, null)
        surfaceTextureHelper = SurfaceTextureHelper.create("CaptureThread", eglBase!!.eglBaseContext)
        localVideoSource = factory?.createVideoSource(videoCapturer!!.isScreencast)
        videoCapturer?.initialize(surfaceTextureHelper, context, localVideoSource?.capturerObserver)
        videoCapturer?.startCapture(VIDEO_WIDTH, VIDEO_HEIGHT, VIDEO_FPS)

        localVideoTrack = factory?.createVideoTrack("video0", localVideoSource)
        localVideoTrack?.setEnabled(true)

        if (renderer != null) {
            localRenderer = renderer
            localVideoTrack?.addSink(renderer)
        }

        // Add to specific PC or all active PCs
        if (peerId.isNotEmpty()) {
            peerConnections[peerId]?.addTrack(localVideoTrack, listOf("stream0"))
        } else {
            for ((_, pc) in peerConnections) {
                pc.addTrack(localVideoTrack, listOf("stream0"))
            }
        }
        Log.d(TAG, "Local video started with camera: $cameraName (peerId=$peerId, pcs=${peerConnections.size})")
    }

    fun setVideoEnabled(enabled: Boolean) {
        localVideoTrack?.setEnabled(enabled)
        if (enabled && videoCapturer == null) {
            startLocalVideo("", localRenderer)
        }
    }

    fun setAudioEnabled(enabled: Boolean) {
        localAudioTrack?.setEnabled(enabled)
    }

    fun switchCamera() {
        videoCapturer?.switchCamera(object : CameraVideoCapturer.CameraSwitchHandler {
            override fun onCameraSwitchDone(isFrontFacing: Boolean) {
                Log.d(TAG, "Camera switched, front: $isFrontFacing")
            }
            override fun onCameraSwitchError(error: String) {
                Log.e(TAG, "Camera switch error: $error")
            }
        })
    }

    // -----------------------------------------------------------------------
    // Screen Sharing (MediaProjection)
    // -----------------------------------------------------------------------

    fun startScreenCapture(resultCode: Int, data: Intent) {
        if (isScreenSharing) return

        // Pause camera
        videoCapturer?.stopCapture()
        localVideoTrack?.setEnabled(false)

        screenSurfaceHelper = SurfaceTextureHelper.create("ScreenCaptureThread", eglBase!!.eglBaseContext)
        screenVideoSource = factory?.createVideoSource(true) // isScreencast = true
        screenCapturer = ScreenCapturerAndroid(data, object : MediaProjection.Callback() {
            override fun onStop() {
                Log.d(TAG, "MediaProjection stopped")
                stopScreenCapture()
            }
        })
        screenCapturer?.initialize(screenSurfaceHelper, context, screenVideoSource?.capturerObserver)
        screenCapturer?.startCapture(VIDEO_WIDTH, VIDEO_HEIGHT, VIDEO_FPS)

        screenVideoTrack = factory?.createVideoTrack("screen0", screenVideoSource)
        screenVideoTrack?.setEnabled(true)

        // Replace camera track with screen track on all active peer connections
        for ((_, pc) in peerConnections) {
            val videoSender = pc.senders?.firstOrNull { it.track()?.kind() == "video" }
            if (videoSender != null) {
                videoSender.setTrack(screenVideoTrack, false)
            } else {
                pc.addTrack(screenVideoTrack, listOf("screen_stream"))
            }
        }

        isScreenSharing = true
        Log.d(TAG, "Screen capture started")
    }

    fun stopScreenCapture() {
        if (!isScreenSharing) return

        try {
            screenCapturer?.stopCapture()
        } catch (e: Exception) {
            Log.e(TAG, "Error stopping screen capture", e)
        }
        screenCapturer?.dispose()
        screenCapturer = null
        screenSurfaceHelper?.dispose()
        screenSurfaceHelper = null
        screenVideoTrack?.dispose()
        screenVideoTrack = null
        screenVideoSource?.dispose()
        screenVideoSource = null

        // Restore camera track on all active peer connections
        for ((_, pc) in peerConnections) {
            val videoSender = pc.senders?.firstOrNull { it.track()?.kind() == "video" || it.track() == null }
            if (videoSender != null && localVideoTrack != null) {
                videoSender.setTrack(localVideoTrack, false)
            }
        }
        localVideoTrack?.setEnabled(true)
        videoCapturer?.startCapture(VIDEO_WIDTH, VIDEO_HEIGHT, VIDEO_FPS)

        isScreenSharing = false
        Log.d(TAG, "Screen capture stopped, camera restored")
    }

    fun isScreenSharing(): Boolean = isScreenSharing

    // -----------------------------------------------------------------------
    // Remote Media
    // -----------------------------------------------------------------------

    fun attachRemoteRenderer(renderer: SurfaceViewRenderer) {
        remoteRenderer = renderer
    }

    fun addRemoteTrackSink(track: VideoTrack) {
        remoteRenderer?.let { track.addSink(it) }
    }

    // -----------------------------------------------------------------------
    // Stats & Info
    // -----------------------------------------------------------------------

    fun getConnectionState(peerId: String): String {
        return peerConnections[peerId]?.connectionState()?.name ?: "UNKNOWN"
    }

    // -----------------------------------------------------------------------
    // Cleanup
    // -----------------------------------------------------------------------

    fun closePeerConnection(peerId: String) {
        val pc = peerConnections.remove(peerId)
        if (pc != null) {
            try {
                pc.close()
            } catch (e: Exception) {
                Log.e(TAG, "[$peerId] Error closing peer connection", e)
            }
            Log.d(TAG, "[$peerId] PeerConnection closed (remaining: ${peerConnections.size})")
        }

        // Only stop local media if no more active PCs
        if (peerConnections.isEmpty()) {
            stopLocalMedia()
            listener = null
        }
    }

    private fun stopLocalMedia() {
        localVideoTrack?.let { track ->
            localRenderer?.let { track.removeSink(it) }
        }
        videoCapturer?.stopCapture()
        videoCapturer?.dispose()
        videoCapturer = null
        surfaceTextureHelper?.dispose()
        surfaceTextureHelper = null

        localVideoTrack?.dispose()
        localVideoTrack = null
        localVideoSource?.dispose()
        localVideoSource = null

        localAudioTrack?.dispose()
        localAudioTrack = null
        localAudioSource?.dispose()
        localAudioSource = null
    }

    fun closeAllPeerConnections() {
        for ((peerId, pc) in peerConnections.toMap()) {
            try { pc.close() } catch (_: Exception) {}
            Log.d(TAG, "[$peerId] Closed")
        }
        peerConnections.clear()
        stopLocalMedia()
        listener = null
        Log.d(TAG, "All PeerConnections closed")
    }

    fun dispose() {
        closeAllPeerConnections()

        factory?.dispose()
        factory = null
        eglBase?.release()
        eglBase = null
        isInitialized = false
        Log.d(TAG, "Disposed")
    }
}
