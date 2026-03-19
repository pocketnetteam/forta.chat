package com.bastyon.chat.plugins.webrtc

import android.content.Context
import android.content.Intent
import android.media.projection.MediaProjection
import android.util.Log
import org.webrtc.*
import org.webrtc.audio.JavaAudioDeviceModule

/**
 * Manages native WebRTC peer connection lifecycle with hardware-accelerated
 * video encoding/decoding via Google's libwebrtc.
 */
class NativeWebRTCManager(private val context: Context) {

    companion object {
        private const val TAG = "NativeWebRTCManager"
        private const val VIDEO_WIDTH = 1280
        private const val VIDEO_HEIGHT = 720
        private const val VIDEO_FPS = 30
    }

    interface Listener {
        fun onIceCandidate(candidate: IceCandidate)
        fun onIceConnectionStateChange(state: PeerConnection.IceConnectionState)
        fun onAddTrack(receiver: RtpReceiver, streams: Array<out MediaStream>)
        fun onRemoveTrack(receiver: RtpReceiver)
        fun onRenegotiationNeeded()
    }

    private var factory: PeerConnectionFactory? = null
    private var peerConnection: PeerConnection? = null
    private var eglBase: EglBase? = null

    // Local media
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

    fun createPeerConnection(iceServers: List<PeerConnection.IceServer>, listener: Listener) {
        this.listener = listener
        val rtcConfig = PeerConnection.RTCConfiguration(iceServers).apply {
            sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
            continualGatheringPolicy = PeerConnection.ContinualGatheringPolicy.GATHER_CONTINUALLY
            iceCandidatePoolSize = 10
        }

        peerConnection = factory?.createPeerConnection(rtcConfig, object : PeerConnection.Observer {
            override fun onIceCandidate(candidate: IceCandidate) {
                Log.d(TAG, "onIceCandidate: ${candidate.sdpMid}")
                listener.onIceCandidate(candidate)
            }

            override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>) {}

            override fun onIceConnectionChange(state: PeerConnection.IceConnectionState) {
                Log.d(TAG, "ICE connection state: $state")
                listener.onIceConnectionStateChange(state)
            }

            override fun onIceConnectionReceivingChange(receiving: Boolean) {}
            override fun onIceGatheringChange(state: PeerConnection.IceGatheringState) {}

            override fun onAddStream(stream: MediaStream) {}
            override fun onRemoveStream(stream: MediaStream) {}

            override fun onAddTrack(receiver: RtpReceiver, streams: Array<out MediaStream>) {
                Log.d(TAG, "onAddTrack: ${receiver.track()?.kind()}")
                listener.onAddTrack(receiver, streams)
            }

            override fun onTrack(transceiver: RtpTransceiver) {
                Log.d(TAG, "onTrack: ${transceiver.receiver.track()?.kind()}")
            }

            override fun onRemoveTrack(receiver: RtpReceiver) {
                listener.onRemoveTrack(receiver)
            }

            override fun onDataChannel(dc: DataChannel) {}
            override fun onSignalingChange(state: PeerConnection.SignalingState) {}
            override fun onConnectionChange(state: PeerConnection.PeerConnectionState) {
                Log.d(TAG, "Connection state: $state")
            }
            override fun onRenegotiationNeeded() {
                listener.onRenegotiationNeeded()
            }
            override fun onSelectedCandidatePairChanged(event: CandidatePairChangeEvent?) {}
        })

        Log.d(TAG, "PeerConnection created")
    }

    // -----------------------------------------------------------------------
    // SDP
    // -----------------------------------------------------------------------

    fun createOffer(callback: (SessionDescription?) -> Unit) {
        val constraints = MediaConstraints().apply {
            mandatory.add(MediaConstraints.KeyValuePair("OfferToReceiveAudio", "true"))
            mandatory.add(MediaConstraints.KeyValuePair("OfferToReceiveVideo", "true"))
        }
        peerConnection?.createOffer(object : SdpObserver {
            override fun onCreateSuccess(sdp: SessionDescription) {
                Log.d(TAG, "createOffer success")
                callback(sdp)
            }
            override fun onCreateFailure(error: String) {
                Log.e(TAG, "createOffer failed: $error")
                callback(null)
            }
            override fun onSetSuccess() {}
            override fun onSetFailure(error: String) {}
        }, constraints)
    }

    fun createAnswer(callback: (SessionDescription?) -> Unit) {
        val constraints = MediaConstraints().apply {
            mandatory.add(MediaConstraints.KeyValuePair("OfferToReceiveAudio", "true"))
            mandatory.add(MediaConstraints.KeyValuePair("OfferToReceiveVideo", "true"))
        }
        peerConnection?.createAnswer(object : SdpObserver {
            override fun onCreateSuccess(sdp: SessionDescription) {
                Log.d(TAG, "createAnswer success")
                callback(sdp)
            }
            override fun onCreateFailure(error: String) {
                Log.e(TAG, "createAnswer failed: $error")
                callback(null)
            }
            override fun onSetSuccess() {}
            override fun onSetFailure(error: String) {}
        }, constraints)
    }

    fun setLocalDescription(sdp: SessionDescription, callback: (Boolean) -> Unit) {
        peerConnection?.setLocalDescription(object : SdpObserver {
            override fun onSetSuccess() {
                Log.d(TAG, "setLocalDescription success")
                callback(true)
            }
            override fun onSetFailure(error: String) {
                Log.e(TAG, "setLocalDescription failed: $error")
                callback(false)
            }
            override fun onCreateSuccess(sdp: SessionDescription?) {}
            override fun onCreateFailure(error: String?) {}
        }, sdp)
    }

    fun setRemoteDescription(sdp: SessionDescription, callback: (Boolean) -> Unit) {
        peerConnection?.setRemoteDescription(object : SdpObserver {
            override fun onSetSuccess() {
                Log.d(TAG, "setRemoteDescription success")
                callback(true)
            }
            override fun onSetFailure(error: String) {
                Log.e(TAG, "setRemoteDescription failed: $error")
                callback(false)
            }
            override fun onCreateSuccess(sdp: SessionDescription?) {}
            override fun onCreateFailure(error: String?) {}
        }, sdp)
    }

    fun addIceCandidate(candidate: IceCandidate): Boolean {
        return peerConnection?.addIceCandidate(candidate) ?: false
    }

    // -----------------------------------------------------------------------
    // Local Media
    // -----------------------------------------------------------------------

    fun startLocalAudio() {
        if (localAudioTrack != null) return

        val audioConstraints = MediaConstraints().apply {
            mandatory.add(MediaConstraints.KeyValuePair("googEchoCancellation", "true"))
            mandatory.add(MediaConstraints.KeyValuePair("googNoiseSuppression", "true"))
            mandatory.add(MediaConstraints.KeyValuePair("googAutoGainControl", "true"))
        }

        localAudioSource = factory?.createAudioSource(audioConstraints)
        localAudioTrack = factory?.createAudioTrack("audio0", localAudioSource)
        localAudioTrack?.setEnabled(true)

        peerConnection?.addTrack(localAudioTrack, listOf("stream0"))
        Log.d(TAG, "Local audio started")
    }

    fun startLocalVideo(renderer: SurfaceViewRenderer? = null) {
        if (localVideoTrack != null) return

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

        peerConnection?.addTrack(localVideoTrack, listOf("stream0"))
        Log.d(TAG, "Local video started with camera: $cameraName")
    }

    fun setVideoEnabled(enabled: Boolean) {
        localVideoTrack?.setEnabled(enabled)
        if (enabled && videoCapturer == null) {
            startLocalVideo(localRenderer)
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

        // Replace camera track with screen track on the peer connection
        val videoSender = peerConnection?.senders?.firstOrNull { it.track()?.kind() == "video" }
        if (videoSender != null) {
            videoSender.setTrack(screenVideoTrack, false)
        } else {
            peerConnection?.addTrack(screenVideoTrack, listOf("screen_stream"))
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

        // Restore camera track
        val videoSender = peerConnection?.senders?.firstOrNull { it.track()?.kind() == "video" || it.track() == null }
        if (videoSender != null && localVideoTrack != null) {
            videoSender.setTrack(localVideoTrack, false)
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
        // Will be used when remote track arrives via onAddTrack
    }

    fun addRemoteTrackSink(track: VideoTrack) {
        remoteRenderer?.let { track.addSink(it) }
    }

    // -----------------------------------------------------------------------
    // Stats & Info
    // -----------------------------------------------------------------------

    fun getConnectionState(): String {
        return peerConnection?.connectionState()?.name ?: "UNKNOWN"
    }

    // -----------------------------------------------------------------------
    // Cleanup
    // -----------------------------------------------------------------------

    fun closePeerConnection() {
        try {
            peerConnection?.close()
        } catch (e: Exception) {
            Log.e(TAG, "Error closing peer connection", e)
        }
        peerConnection = null
        stopLocalMedia()
        listener = null
        Log.d(TAG, "PeerConnection closed")
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

    fun dispose() {
        closePeerConnection()
        factory?.dispose()
        factory = null
        eglBase?.release()
        eglBase = null
        isInitialized = false
        Log.d(TAG, "Disposed")
    }
}
